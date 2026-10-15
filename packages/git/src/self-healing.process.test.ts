import { access, chmod, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService, type RetiredLease } from "./index.ts";
import { git, holdGit, proxyGit, scalar, scratch } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A repository at a plain path, so the process listing can name the Git working in it. */
async function plainRepository() {
  const repo = await scratch();
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "commit", "--allow-empty", "-m", "Initial");
  return repo;
}

async function preCommitHook(repo: string, script: string) {
  const hook = join(repo, ".git", "hooks", "pre-commit");
  await writeFile(hook, `#!/bin/sh\n${script}\n`);
  await chmod(hook, 0o755);
}

const journal = (repo: string) =>
  readdir(join(repo, ".git", "ace-mutation-leases")).catch(() => []);

test("a killed git call's lease is retired automatically and the next send succeeds without user action", async () => {
  const repo = await plainRepository();
  // write-tree hangs until ace's deadline kills its whole process group.
  const binary = await proxyGit(
    `if (args.includes('write-tree')) { setInterval(()=>{},1000); return; }`,
  );
  const retired: RetiredLease[] = [];
  const stuck = new GitService({
    gitBinary: binary,
    timeoutMs: 1000,
    onLeaseRetired: (event) => retired.push(event),
  });
  const next = new GitService({ onLeaseRetired: (event) => retired.push(event) });
  try {
    await expect(
      stuck.createCheckpoint({ worktree: repo, threadId: "send", label: "stuck" }),
    ).rejects.toMatchObject({ code: "git_timeout" });
    await expect(
      next.createCheckpoint({ worktree: repo, threadId: "send", label: "next" }),
    ).resolves.toMatchObject({ label: "next" });
    expect(await journal(repo)).toEqual([]);
    expect(retired).toMatchObject([{ reason: "own_processes_gone" }]);
  } finally {
    await stuck.close();
    await next.close();
  }
});

test("a leftover index.lock from a killed ace git call is cleaned automatically", async () => {
  const repo = await plainRepository();
  const started = join(repo, "..", "hook-started");
  await preCommitHook(repo, `touch '${started}'\nsleep 300`);
  await writeFile(join(repo, "file.txt"), "change\n");
  const head = await scalar(repo, "rev-parse", "HEAD");
  const closing = new GitService();
  const commit = closing
    // Committing named paths makes Git hold index.lock while the hook runs.
    .commit({ worktree: repo, message: "Killed", expectedHead: head, paths: ["file.txt"] })
    .catch((error: unknown) => error);
  await expect.poll(() => exists(started), { timeout: 10_000 }).toBe(true);
  expect(await exists(join(repo, ".git", "index.lock"))).toBe(true);
  // Old enough that it can't belong to a Git command that is only starting.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  // Shutting the service down kills the commit, hook included, mid-flight.
  await closing.close();
  expect(await commit).toMatchObject({ code: "git_closed" });
  expect(await exists(join(repo, ".git", "index.lock"))).toBe(false);
  expect((await readdir(join(repo, ".git"))).filter((name) => name.endsWith(".lock"))).toEqual([]);
  expect(await journal(repo)).toEqual([]);
  await preCommitHook(repo, "exit 0");
  const next = new GitService();
  try {
    await expect(
      next.commit({ worktree: repo, message: "Next", expectedHead: head }),
    ).resolves.toMatch(/^[a-f0-9]{40,64}$/);
  } finally {
    await next.close();
  }
});

test("a pre-commit hook slower than the default Git deadline still commits", async () => {
  const repo = await plainRepository();
  await preCommitHook(repo, "sleep 2");
  await writeFile(join(repo, "file.txt"), "change\n");
  const service = new GitService({ timeoutMs: 1000 });
  try {
    const commit = await service.commit({
      worktree: repo,
      message: "Slow hook",
      expectedHead: await scalar(repo, "rev-parse", "HEAD"),
    });
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(commit);
    expect(await scalar(repo, "log", "-1", "--format=%s")).toBe("Slow hook");
  } finally {
    await service.close();
  }
});

test("the user's own running git's index.lock is never removed", async () => {
  const repo = await plainRepository();
  const lock = join(repo, ".git", "index.lock");
  await writeFile(lock, "");
  const longAgo = new Date(Date.now() - 600_000);
  await utimes(lock, longAgo, longAgo);
  const holder = await holdGit(repo);
  const service = new GitService();
  try {
    expect(await service.heal(repo)).toEqual([]);
    expect(await exists(lock)).toBe(true);
    // Once no Git process works there, the same leftover lock is removed.
    await holder.stop();
    expect(await service.heal(repo)).toEqual([lock]);
    expect(await exists(lock)).toBe(false);
  } finally {
    await service.close();
  }
});
