import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService, spawnGitProcess, type RetiredLease } from "./index.ts";
import { git, repository, scalar, scratch } from "./test-repo.ts";

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
  return new GitService({ onLeaseRetired: (event) => retired.push(event) });
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

test("a lease for one worktree doesn't block a sibling worktree, but fences its own", async () => {
  const { main, x, y, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const git2 = service();
  try {
    await expect(checkpoint(git2, y)).resolves.toMatchObject({ label: "after" });
    await expect(checkpoint(git2, main)).resolves.toMatchObject({ label: "after" });
    await expect(checkpoint(git2, x)).rejects.toMatchObject({ code: "git_quarantined" });
    expect(await exists(lease)).toBe(true);
  } finally {
    await git2.close();
  }
});

test("a stale lease on the main checkout fences every worktree of the repository", async () => {
  const { main, y, journal } = await worktrees();
  await leftLease(journal, main);
  const git2 = service();
  try {
    await expect(checkpoint(git2, y)).rejects.toMatchObject({ code: "git_quarantined" });
    await expect(checkpoint(git2, main)).rejects.toMatchObject({ code: "git_quarantined" });
  } finally {
    await git2.close();
  }
});

test("a stopped daemon's half-finished mutation in a worktree that still exists stays quarantined and says so", async () => {
  const { main, x, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const git2 = service();
  try {
    const failure = await git2.assertMutationAvailable(x).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitError);
    if (!(failure instanceof GitError)) return;
    expect(failure.code).toBe("git_quarantined");
    expect(failure.message).toContain(`Git changes in ${main} are blocked`);
    expect(failure.message).toContain(`a Git operation in ${x}`);
    expect(failure.message).toContain("ace daemon running it stopped");
    expect(failure.message).toContain("Clear stale lock");
    expect(await exists(lease)).toBe(true);
  } finally {
    await git2.close();
  }
});

test("Clear stale lock retires a stopped daemon's lease after verifying its owner is gone", async () => {
  const { main, x, journal } = await worktrees();
  const lease = await leftLease(journal, x);
  const retired: RetiredLease[] = [];
  const git2 = service(retired);
  try {
    const cleared = await git2.clearStaleLeases(x);
    expect(cleared).toMatchObject({ state: { status: "available" }, retired: [{ root: x }] });
    expect(await exists(lease)).toBe(false);
    expect(retired).toMatchObject([{ repository: main, reason: "confirmed_stale" }]);
    await expect(checkpoint(git2, x)).resolves.toMatchObject({ label: "after" });
  } finally {
    await git2.close();
  }
});

test("a lease whose daemon is still alive keeps blocking, and Clear stale lock leaves it", async () => {
  const { x } = await worktrees();
  // This daemon's own Git process fails mid-checkpoint with no proof its writers stopped.
  const owner = new GitService({
    processRuntime: {
      spawn: (binary, args, options) => {
        if (!args.includes("read-tree")) return spawnGitProcess(binary, args, options);
        const child = spawnGitProcess(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          options,
        );
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
  } finally {
    await owner.close();
    await other.close();
  }
});
