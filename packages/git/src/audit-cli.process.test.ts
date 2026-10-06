import { spawnGitProcess as spawn } from "./index.ts";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService } from "./index.ts";
import { repository, scratch } from "./test-repo.ts";

test.each(["stdout", "stderr"] as const)(
  "a %s read failure rejects with the original error and the service remains usable",
  async (pipe) => {
    const repo = await repository();
    const exited = Promise.withResolvers<void>();
    let inject = true;
    const service = new GitService({
      processRuntime: {
        spawn: (command, args, options) => {
          const child = spawn(command, args, options);
          if (inject && args.includes("status")) {
            inject = false;
            child.once("exit", () => exited.resolve());
            child.once("spawn", () =>
              child[pipe].destroy(
                Object.assign(new Error(`synthetic ${pipe} EIO`), { code: "EIO" }),
              ),
            );
          }
          return child;
        },
      },
    });
    const failure = await service.status(repo).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "filesystem_error",
      details: { errno: "EIO" },
      message: `synthetic ${pipe} EIO`,
    });
    if (!(failure instanceof GitError) || !failure.cleanup)
      throw new Error("Missing cleanup receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    await expect(service.status(repo)).rejects.toMatchObject({ code: "git_quarantined" });
    const recovery = new GitService({
      processRuntime: {
        cleanupSupervisor: {
          stop: () => {
            throw new Error("Recovery must not spawn a command");
          },
          recover: async () => ({
            status: "confirmed",
            evidence: "Exclusive fixture: hook-free status exited, with no descendants",
          }),
        },
      },
    });
    await exited.promise;
    await recovery.recoverCleanup(repo);
    expect(await service.status(repo)).toMatchObject({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
  },
);

test("a service retries executable verification after a transient missing binary", async () => {
  const repo = await repository();
  const missing = join(await scratch(), "missing-git");
  let fail = true;
  const service = new GitService({
    processRuntime: {
      spawn: (command, args, options) => {
        const executable = fail ? missing : command;
        fail = false;
        return spawn(executable, args, options);
      },
    },
  });
  await expect(service.repositoryInfo(repo)).rejects.toMatchObject({ code: "git_missing" });
  expect(await service.repositoryInfo(repo)).toMatchObject({ root: repo, branch: "main" });
});

test("the first output failure survives a second pipe error and an expiring deadline", async () => {
  const repo = await repository();
  const deadlines = new Set<() => void>();
  const exited = Promise.withResolvers<void>();
  let inject = true;
  const service = new GitService({
    processRuntime: {
      spawn: (command, args, options) => {
        const child = spawn(command, args, options);
        if (inject && args.includes("status")) {
          inject = false;
          child.once("exit", () => exited.resolve());
          child.stdout.once("error", () =>
            queueMicrotask(() => {
              for (const expire of Array.from(deadlines)) expire();
            }),
          );
          child.once("spawn", () => {
            child.stdout.destroy(Object.assign(new Error("first EIO"), { code: "EIO" }));
            child.stderr.destroy(Object.assign(new Error("later EPIPE"), { code: "EPIPE" }));
          });
        }
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
  const failure = await service.status(repo).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "filesystem_error",
    message: "first EIO",
    details: { errno: "EIO" },
  });
  if (!(failure instanceof GitError) || !failure.cleanup)
    throw new Error("Missing cleanup receipt");
  expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
  await exited.promise;
  await new GitService({
    processRuntime: {
      cleanupSupervisor: {
        stop: () => {
          throw new Error("Recovery must not spawn a command");
        },
        recover: async () => ({
          status: "confirmed",
          evidence: "Exclusive hook-free Git fixture exited without descendants",
        }),
      },
    },
  }).recoverCleanup(repo);
  expect(await service.repositoryInfo(repo)).toMatchObject({ branch: "main" });
});
