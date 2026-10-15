import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess, type RetiredLease } from "./index.ts";
import { git, holdGit, repository, scalar, scratch } from "./test-repo.ts";

/** A local port nothing listens on: the endpoint of a daemon that has stopped. */
async function stoppedDaemonPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** A repository with two linked worktrees, X and Y, as a daemon would leave them. */
async function worktrees() {
  const main = await repository();
  const parent = await scratch();
  const x = join(parent, "worktree-x");
  const y = join(parent, "worktree-y");
  await git(main, "worktree", "add", "-b", "x", x);
  await git(main, "worktree", "add", "-b", "y", y);
  const common = await realpath(join(main, await scalar(main, "rev-parse", "--git-common-dir")));
  return {
    main,
    x: await realpath(x),
    y: await realpath(y),
    journal: join(common, "ace-mutation-leases"),
  };
}

/** The durable intent a daemon writes before it mutates `root`, then never retires. */
async function leftLease(journal: string, root: string, roots: string[] = [root]) {
  const id = randomUUID();
  await mkdir(journal, { recursive: true });
  const file = join(journal, id);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      id,
      root,
      owner: { port: await stoppedDaemonPort(), token: randomUUID() },
      roots,
    }),
  );
  return file;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

function service(retired: RetiredLease[] = []) {
  // No waiting: these tests look at what a lease fences at the moment they ask.
  return new GitService({ onLeaseRetired: (event) => retired.push(event), leaseWaitMs: 0 });
}
const checkpoint = (owner: GitService, worktree: string) =>
  owner.createCheckpoint({ worktree, threadId: "stale", label: "after" });

test.each(["removed", "pruned"] as const)(
  "a lease whose daemon stopped and whose worktree was %s is retired, and Git work proceeds",
  async (fate) => {
    const { main, x, y, journal } = await worktrees();
    const lease = await leftLease(journal, x);
    if (fate === "removed") await git(main, "worktree", "remove", "--force", x);
    else {
      // The checkout's files stay behind, but Git no longer knows it as a worktree.
      await rm(join(main, ".git", "worktrees", "worktree-x"), { recursive: true });
    }
    const retired: RetiredLease[] = [];
    const git2 = service(retired);
    try {
      await expect(checkpoint(git2, y)).resolves.toMatchObject({ label: "after" });
      await expect(checkpoint(git2, main)).resolves.toMatchObject({ label: "after" });
      expect(await exists(lease)).toBe(false);
      expect(retired).toMatchObject([
        { repository: main, reason: "owner_gone_roots_settled", lease: { root: x } },
      ]);
    } finally {
      await git2.close();
    }
  },
);

test("a lease for one worktree doesn't block a sibling worktree, but fences its own while Git still runs there", async () => {
  const { main, x, y, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const holder = await holdGit(x);
  const git2 = service();
  try {
    await expect(checkpoint(git2, y)).resolves.toMatchObject({ label: "after" });
    await expect(checkpoint(git2, main)).resolves.toMatchObject({ label: "after" });
    await expect(checkpoint(git2, x)).rejects.toMatchObject({ code: "git_quarantined" });
    expect(await exists(lease)).toBe(true);
    await holder.stop();
    await expect(checkpoint(git2, x)).resolves.toMatchObject({ label: "after" });
    expect(await exists(lease)).toBe(false);
  } finally {
    await git2.close();
  }
});

test("a stale lease inside a nested linked worktree does not block sends or git in the main checkout", async () => {
  const main = await realpath(await scratch());
  await git(main, "init", "--initial-branch=main");
  await git(main, "config", "user.name", "Fixture");
  await git(main, "config", "user.email", "fixture@example.invalid");
  // Agent worktrees live in an ignored directory, so the main checkout's snapshots skip them.
  await writeFile(join(main, ".gitignore"), ".claude/\n");
  await git(main, "add", ".gitignore");
  await git(main, "commit", "-m", "Initial");
  const nested = join(main, ".claude", "worktrees", "agent-x");
  await git(main, "worktree", "add", "-b", "agent-x", nested);
  const lease = await leftLease(join(main, ".git", "ace-mutation-leases"), nested);
  // Git still runs in the nested worktree, so its lease can't be retired yet.
  const holder = await holdGit(nested);
  const git2 = service();
  try {
    await expect(git2.assertMutationAvailable(main)).resolves.toBeUndefined();
    await expect(checkpoint(git2, main)).resolves.toMatchObject({ label: "after" });
    await expect(checkpoint(git2, nested)).rejects.toMatchObject({ code: "git_quarantined" });
    expect(await exists(lease)).toBe(true);
  } finally {
    await holder.stop();
    await git2.close();
  }
});

test("a stale lease on the main checkout fences every worktree of the repository while Git still runs there", async () => {
  const { main, y, journal } = await worktrees();
  await leftLease(journal, main);
  const holder = await holdGit(main);
  const git2 = service();
  try {
    await expect(checkpoint(git2, y)).rejects.toMatchObject({ code: "git_quarantined" });
    await expect(checkpoint(git2, main)).rejects.toMatchObject({ code: "git_quarantined" });
  } finally {
    await holder.stop();
    await git2.close();
  }
});

test("a stopped daemon's lease on a checkout where Git still runs names the process that holds it", async () => {
  const { main, x, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const holder = await holdGit(x);
  const git2 = service();
  try {
    const failure = await git2.assertMutationAvailable(x).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitError);
    if (!(failure instanceof GitError)) return;
    expect(failure.code).toBe("git_quarantined");
    expect(failure.message).toContain(`Git changes in ${main} are blocked`);
    expect(failure.message).toContain(`a Git operation in ${x}`);
    expect(failure.message).toContain(`pid ${holder.pid}`);
    expect(await exists(lease)).toBe(true);
  } finally {
    await holder.stop();
    await git2.close();
  }
});

test("a stopped daemon's lease on a checkout that still exists retires once no Git process runs there", async () => {
  const { main, x, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const retired: RetiredLease[] = [];
  const git2 = service(retired);
  try {
    await expect(checkpoint(git2, x)).resolves.toMatchObject({ label: "after" });
    expect(await exists(lease)).toBe(false);
    expect(retired).toMatchObject([
      { repository: main, reason: "owner_gone_processes_gone", lease: { root: x } },
    ]);
  } finally {
    await git2.close();
  }
});

test("a lease whose git process is still alive is never retired", async () => {
  const { x } = await worktrees();
  let writer: ChildProcessWithoutNullStreams | undefined;
  // This daemon's own Git process fails mid-checkpoint, and the kill request never reaches it.
  const owner = new GitService({
    leaseWaitMs: 0,
    processRuntime: {
      signalGroup: () => {},
      spawn: (binary, args, options) => {
        if (!args.includes("read-tree")) return spawnGitProcess(binary, args, options);
        const child = spawnGitProcess(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          options,
        );
        writer = child;
        child.once("spawn", () =>
          child.stdout.destroy(Object.assign(new Error("Fixture EIO"), { code: "EIO" })),
        );
        return child;
      },
    },
  });
  const other = service();
  try {
    const failure = await checkpoint(owner, x).catch((error: unknown) => error);
    if (!(failure instanceof GitError) || !failure.cleanup) throw new Error("Missing receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    await expect(checkpoint(other, x)).rejects.toMatchObject({ code: "git_quarantined" });
    const cleared = await other.clearStaleLeases(x);
    expect(cleared).toMatchObject({ retired: [], state: { status: "quarantined" } });
    await expect(checkpoint(other, x)).rejects.toMatchObject({ code: "git_quarantined" });
    // Once the process is really gone, the same lease retires without anyone asking.
    if (!writer) throw new Error("Missing fixture writer");
    const exited = once(writer, "exit");
    writer.kill("SIGKILL");
    await exited;
    await expect
      .poll(() => other.mutationState(x), { timeout: 10_000 })
      .toMatchObject({ status: "available" });
    await expect(checkpoint(other, x)).resolves.toMatchObject({ label: "after" });
  } finally {
    writer?.kill("SIGKILL");
    await owner.close();
    await other.close();
  }
});
