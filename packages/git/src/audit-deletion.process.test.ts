import { watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { GitService } from "./index.ts";
import { proxyGit, repository, scalar, scratch } from "./test-repo.ts";

async function withDeletionGate<T>(
  repo: string,
  intercept: string,
  operation: (
    deletion: Promise<{ deleted: number }>,
    ready: Promise<void>,
    release: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const directory = await scratch();
  const reached = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, name) => {
    if (name === "ready") reached.resolve();
  });
  watcher.on("error", reached.reject);
  let deletion: Promise<{ deleted: number }> | undefined;
  const release = () => writeFile(join(directory, "release"), "release");
  let cleanupFlight: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupFlight ??= (async () => {
      watcher.close();
      await release().catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
      await deletion?.catch(() => {});
    })());
  // Register before setup or Git can fail. This also runs if the test times out
  // while waiting at the gate, so a watcher never outlives the test lifecycle.
  onTestFinished(cleanup);
  try {
    const binary = await proxyGit(`${intercept}
      if (args.includes('for-each-ref') && args.includes('refs/ace/checkpoints/race/')) {
        const result = spawnSync('git', args);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        const watcher = fs.watch(${JSON.stringify(directory)}, (_event, name) => {
          if (name === 'release') { watcher.close(); process.exit(result.status ?? 71); }
        });
        fs.writeFileSync(${JSON.stringify(join(directory, "ready"))}, 'ready');
        if (fs.existsSync(${JSON.stringify(join(directory, "release"))})) {
          watcher.close(); process.exit(result.status ?? 71);
        }
        return;
      }
    `);
    deletion = new GitService({ gitBinary: binary }).deleteCheckpoints({ repo, threadId: "race" });
    const ready = Promise.race([
      reached.promise,
      deletion.then(() => {
        throw new Error("Deletion completed before the ref-enumeration gate");
      }),
    ]);
    return await operation(deletion, ready, release);
  } finally {
    await cleanup();
  }
}

test.each(["present", "absent"])(
  "deletion rejects a concurrent linked-worktree allocation when the counter was %s",
  async (counter) => {
    const repo = await repository();
    const service = new GitService();
    const first =
      counter === "present"
        ? await service.createCheckpoint({ worktree: repo, threadId: "race", label: "first" })
        : undefined;
    const linked = join(await scratch(), "linked");
    await service.createWorktree({ repo, path: linked, baseRef: "HEAD", branch: "linked" });
    await withDeletionGate(repo, "", async (deletion, ready, release) => {
      await ready;
      const second = await service.createCheckpoint({
        worktree: linked,
        threadId: "race",
        label: "concurrent",
      });
      await release();
      await expect(deletion).rejects.toMatchObject({ code: "git_failed" });
      expect(await service.listCheckpoints({ repo, threadId: "race" })).toEqual(
        first ? [first, second] : [second],
      );
      expect(await scalar(repo, "rev-parse", "refs/ace/checkpoint-sequences/race")).toBe(
        second.sha,
      );
      expect(await service.deleteCheckpoints({ repo, threadId: "race" })).toEqual({
        deleted: first ? 2 : 1,
      });
      expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
    });
  },
);

test("deletion failure before gate readiness is reported and subsequent work remains usable", async () => {
  const repo = await repository();
  await withDeletionGate(
    repo,
    `if (args.includes('--version')) {
    process.stderr.write('intentional early Git failure'); process.exit(23);
  }`,
    async (_deletion, ready) => {
      await expect(ready).rejects.toMatchObject({
        code: "git_failed",
        message: "intentional early Git failure",
      });
    },
  );
  expect(await new GitService().repositoryInfo(repo)).toMatchObject({ root: repo, branch: "main" });
});
