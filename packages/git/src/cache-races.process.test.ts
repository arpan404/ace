import { watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { GitService, spawnGitProcess, type Checkpoint } from "./index.ts";
import { git, proxyGit, put, scalar, scratch } from "./test-repo.ts";

test.each(["sha1", "sha256"])(
  "evicted %s counters retry a linked-worktree CAS race even when pending reads are evicted again",
  async (format) => {
    const root = await scratch();
    await git(root, "init", `--object-format=${format}`, "-b", "main");
    const ordinary = new GitService();
    onTestFinished(() => ordinary.close());
    await ordinary.init(root);
    const linked = join(await scratch(), "linked");
    await ordinary.createWorktree({ repo: root, path: linked, baseRef: "HEAD", branch: "linked" });
    await put(root, "file.txt", "root content\n");
    await put(linked, "file.txt", "linked content\n");
    const unrelated = await scratch();
    await ordinary.init(unrelated);

    const directory = await scratch();
    const reached = Promise.withResolvers<void>();
    const arrivals = new Set<string>();
    const watcher = watch(directory, (_event, name) => {
      if (name === "root" || name === "linked") arrivals.add(name);
      if (arrivals.size === 2) reached.resolve();
    });
    watcher.on("error", reached.reject);
    const release = () => writeFile(join(directory, "release"), "release");
    let allocation: Promise<Checkpoint[]> | undefined;
    let armed = false;
    let cleanupFlight: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupFlight ??= (async () => {
        watcher.close();
        await release();
        await allocation?.catch(() => {});
      })());
    onTestFinished(cleanup);
    const binary = await proxyGit(`
      if (!fs.existsSync(${JSON.stringify(join(directory, "release"))})) {
        const watcher = fs.watch(${JSON.stringify(directory)}, (_event, name) => {
          if (name === 'release') { watcher.close(); proceed(); }
        });
        fs.writeFileSync(require('node:path').join(${JSON.stringify(directory)},
          process.cwd() === ${JSON.stringify(root)} ? 'root' : 'linked'), 'ready');
        if (fs.existsSync(${JSON.stringify(join(directory, "release"))})) {
          watcher.close(); proceed();
        }
        return;
      }
      function proceed() {
        const child = spawn('git', args, { stdio: 'inherit', shell: false });
        child.on('error', () => process.exit(70));
        child.on('close', code => process.exit(code ?? 71));
      }
    `);
    const service = new GitService({
      checkpointCounterCacheSize: 1,
      processRuntime: {
        spawn(command, args, options) {
          // Both processes wait immediately before their atomic transaction,
          // after reading the same durable counter and creating their commit.
          const gated = armed && args.includes("update-ref") && options.cwd !== unrelated;
          return spawnGitProcess(gated ? binary : command, args, options);
        },
      },
    });
    onTestFinished(() => service.close());
    try {
      const first = await service.createCheckpoint({
        worktree: root,
        threadId: "race",
        label: "one",
      });
      const second = await service.createCheckpoint({
        worktree: linked,
        threadId: "race",
        label: "two",
      });
      await service.createCheckpoint({
        worktree: unrelated,
        threadId: "churn",
        label: "evict both",
      });
      armed = true;
      allocation = Promise.all([
        service.createCheckpoint({ worktree: root, threadId: "race", label: "root race" }),
        service.createCheckpoint({ worktree: linked, threadId: "race", label: "linked race" }),
      ]);
      await Promise.race([
        reached.promise,
        allocation.then(() => {
          throw new Error("Allocations completed before both CAS gates");
        }),
      ]);
      // Evict the pending counter again through a third root while both callers
      // retain their CAS generation. Publication must not depend on residency.
      await service.createCheckpoint({
        worktree: unrelated,
        threadId: "churn",
        label: "evict pending",
      });
      expect(service.resourceUsage().checkpointCounters).toBe(1);
      await release();
      const raced = await allocation;
      expect(raced.map((c) => c.sequence).toSorted((a, b) => a - b)).toEqual([3, 4]);
      for (const saved of raced) {
        expect(saved.sha).toHaveLength(format === "sha256" ? 64 : 40);
        expect(await scalar(root, "show", `${saved.id}:file.txt`)).toBe(
          saved.label === "root race" ? "root content" : "linked content",
        );
      }
      const sorted = [first, second, ...raced].toSorted((a, b) => a.sequence - b.sequence);
      expect(await ordinary.listCheckpoints({ repo: linked, threadId: "race" })).toEqual(sorted);
      expect(await scalar(root, "rev-parse", "refs/ace/checkpoint-sequences/race")).toBe(
        sorted.at(-1)?.sha,
      );
      expect(service.resourceUsage().checkpointCounters).toBe(1);
      const next = await service.createCheckpoint({
        worktree: root,
        threadId: "race",
        label: "after race",
      });
      expect(next.sequence).toBe(5);
      expect(await ordinary.listCheckpoints({ repo: root, threadId: "race" })).toEqual([
        ...sorted,
        next,
      ]);
    } finally {
      await cleanup();
    }
  },
);
