import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import { timestampSlackMs } from "./git-locks.ts";
import { GitService } from "./index.ts";
import { git, scalar, scratch } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const groups: number[] = [];
afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
});

/** A daemon process that commits through ace's Git service until it is killed. */
const daemon = `
const [index, repo, head] = process.argv.slice(1);
const { GitService } = await import(index);
await new GitService().commit({ worktree: repo, message: "Interrupted", expectedHead: head, paths: ["file.txt"] });
`;

/**
 * A daemon killed in the middle of a commit whose Git process then dies too, as a restart that
 * kills the daemon's process tree leaves it: index.lock, the partial commit's temporary index
 * and the daemon's mutation lease stay behind. Meanwhile an agent's own Git keeps reading the
 * checkout from a shell, as agents do all the time.
 */
async function interruptedCommit() {
  const repo = await scratch();
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "commit", "--allow-empty", "-m", "Initial");
  const started = join(await scratch(), "commit-pid");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  // The hook's parent is the committing Git, which holds index.lock while the hook runs.
  await writeFile(hook, `#!/bin/sh\necho $PPID > '${started}'\nexec sleep 300\n`);
  await chmod(hook, 0o755);
  await writeFile(join(repo, "file.txt"), "change\n");
  const head = await scalar(repo, "rev-parse", "HEAD");
  const index = new URL("./index.ts", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", daemon, index, repo, head], {
    env: testGitEnvironment(),
    stdio: "ignore",
  });
  const exited = once(owner, "exit");
  await expect.poll(() => exists(started), { timeout: 20_000 }).toBe(true);
  const committer = Number((await readFile(started, "utf8")).trim());
  groups.push(committer);
  expect(await exists(join(repo, ".git", "index.lock"))).toBe(true);
  // The agent's reader starts well after the lock was written: past any timestamp slack.
  await pause(timestampSlackMs + 1100);
  const reader = spawn("sh", ["-c", "sleep 300 | git cat-file --batch"], {
    cwd: repo,
    env: testGitEnvironment(),
    detached: true,
    stdio: "ignore",
  });
  await once(reader, "spawn");
  if (reader.pid) groups.push(reader.pid);
  // The lock is already older than the grace a starting Git command gets.
  owner.kill("SIGKILL");
  await exited;
  return { repo, head, committer, reader: reader.pid ?? 0 };
}

const leftovers = async (repo: string) => ({
  locks: (await readdir(join(repo, ".git"))).filter((name) => name.endsWith(".lock")),
  leases: await readdir(join(repo, ".git", "ace-mutation-leases")).catch(() => []),
});

async function killCommitter(repo: string, head: string, committer: number) {
  // While the killed daemon's Git still runs, its lock and lease are left alone.
  const early = new GitService({ leaseWaitMs: 0 });
  try {
    await early.heal(repo);
    expect((await leftovers(repo)).locks).toContain("index.lock");
    await expect(
      early.commit({
        worktree: repo,
        message: "Too early",
        expectedHead: head,
        paths: ["file.txt"],
      }),
    ).rejects.toMatchObject({ code: "git_quarantined" });
    expect((await leftovers(repo)).locks).toContain("index.lock");
  } finally {
    await early.close();
  }
  process.kill(-committer, "SIGKILL");
  await expect.poll(() => alive(committer), { timeout: 10_000 }).toBe(false);
  await rm(join(repo, ".git", "hooks", "pre-commit"));
}

test("a restarted daemon's sweep clears the lock and lease a killed commit left, while an agent's Git keeps reading", async () => {
  const { repo, head, committer, reader } = await interruptedCommit();
  await killCommitter(repo, head, committer);
  const restarted = new GitService({ leaseWaitMs: 0 });
  try {
    await restarted.heal(repo);
    expect(await leftovers(repo)).toEqual({ locks: [], leases: [] });
    expect(alive(reader)).toBe(true);
  } finally {
    await restarted.close();
  }
});

test("the next commit after a restart succeeds on its own past a killed commit's lock, while an agent's Git keeps reading", async () => {
  const { repo, head, committer, reader } = await interruptedCommit();
  await killCommitter(repo, head, committer);
  const restarted = new GitService({ leaseWaitMs: 0 });
  try {
    await restarted.commit({
      worktree: repo,
      message: "After restart",
      expectedHead: head,
      paths: ["file.txt"],
    });
    expect(await scalar(repo, "log", "-1", "--format=%s")).toBe("After restart");
    expect(await leftovers(repo)).toEqual({ locks: [], leases: [] });
    expect(alive(reader)).toBe(true);
  } finally {
    await restarted.close();
  }
});
