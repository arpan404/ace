import { once } from "node:events";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess, type GitProcessRuntime } from "./index.ts";
import { git, repository } from "./test-repo.ts";

test("one confirmed process cannot release a snapshot's other unconfirmed writer", async () => {
  const root = await repository({ "child/file.txt": "child\n" });
  const childRoot = join(root, "child");
  await git(childRoot, "init", "--initial-branch=main");
  await git(childRoot, "config", "user.name", "Fixture");
  await git(childRoot, "config", "user.email", "fixture@example.invalid");
  await git(childRoot, "add", "--all");
  await git(childRoot, "commit", "-m", "Child");
  const packReady = Promise.withResolvers<void>();
  let pack: ReturnType<GitProcessRuntime["spawn"]> | undefined;
  const closed: Promise<unknown>[] = [];
  let stops = 0;
  const service = new GitService({
    processRuntime: {
      spawn: (binary, args, options) => {
        if (!args.includes("pack-objects") && !args.includes("unpack-objects"))
          return spawnGitProcess(binary, args, options);
        // Exclusive processes with no descendants. Keep both real pipes open until
        // both ends of public checkpoint transfer are running, then fail both.
        const child = spawnGitProcess(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          options,
        );
        closed.push(once(child, "exit"));
        if (args.includes("pack-objects")) {
          pack = child;
          child.once("spawn", () => packReady.resolve());
        } else
          child.once("spawn", () => {
            void packReady.promise.then(() => {
              pack?.stdout.destroy(Object.assign(new Error("pack EIO"), { code: "EIO" }));
              child.stderr.destroy(Object.assign(new Error("unpack EIO"), { code: "EIO" }));
            });
          });
        return child;
      },
      cleanupSupervisor: {
        stop: (child) => {
          const exit = once(child, "exit");
          child.kill("SIGKILL");
          const confirmed = ++stops === 1;
          return {
            settled: exit.then(() =>
              confirmed
                ? {
                    status: "confirmed",
                    evidence: "Exclusive fixture process without descendants exited",
                  }
                : { status: "unconfirmed", reason: "Second process has no containment proof" },
            ),
          };
        },
        recover: async () => ({ status: "unconfirmed", reason: "No supervisor recovery proof" }),
      },
    },
  });
  try {
    const failure = await service
      .createCheckpoint({ worktree: root, threadId: "receipts", label: "two writers" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "filesystem_error", details: { errno: "EIO" } });
    if (!(failure instanceof GitError) || !failure.cleanup)
      throw new Error("Missing cleanup receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    await Promise.all(closed);
    expect(await service.mutationState(root)).toMatchObject({ status: "quarantined" });
    await expect(
      new GitService().createCheckpoint({ worktree: root, threadId: "blocked", label: "blocked" }),
    ).rejects.toMatchObject({ code: "git_quarantined" });
  } finally {
    await service.close();
    await Promise.all(closed);
  }
});

test("worktree timeout preserves its cleanup receipt without rolling back uncertain resources", async () => {
  const root = await repository();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const deadlines = new Set<() => void>();
  const service = new GitService({
    processRuntime: {
      spawn: (binary, args, options) => {
        if (!args.includes("worktree") || !args.includes("add"))
          return spawnGitProcess(binary, args, options);
        const child = spawnGitProcess(
          process.execPath,
          ["-e", "process.stderr.write('ready');setInterval(()=>{},1000)"],
          options,
        );
        child.stderr.once("data", () => ready.resolve());
        child.once("exit", () => exited.resolve());
        return child;
      },
      scheduleTimeout: (callback) => {
        deadlines.add(callback);
        return () => {
          deadlines.delete(callback);
        };
      },
    },
  });
  const operation = service
    .createWorktree({ repo: root, path: join(root, "linked"), baseRef: "HEAD", branch: "timed" })
    .catch((error: unknown) => error);
  try {
    await Promise.race([
      ready.promise,
      operation.then(() => {
        throw new Error("Worktree ended before readiness");
      }),
    ]);
    for (const expire of Array.from(deadlines)) expire();
    const failure = await operation;
    expect(failure).toMatchObject({ code: "git_timeout" });
    if (!(failure instanceof GitError) || !failure.cleanup)
      throw new Error("Missing original cleanup receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    expect(await service.mutationState(root)).toMatchObject({ status: "quarantined" });
    await expect(
      new GitService().createCheckpoint({ worktree: root, threadId: "blocked", label: "blocked" }),
    ).rejects.toMatchObject({ code: "git_quarantined" });
    await exited.promise;
  } finally {
    await service.close();
    await operation;
  }
});
