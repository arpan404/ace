import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitError, GitService } from "./index.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-sc-git-"));
  tempDirs.push(dir);
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  runGit(dir, ["add", "a.txt"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return dir;
}

async function createRepoWithRemote(): Promise<{ local: string; bare: string; peer: string }> {
  const base = await mkdtemp(join(tmpdir(), "ace-sc-remote-"));
  tempDirs.push(base);
  const bare = join(base, "origin.git");
  const local = join(base, "local");
  const peer = join(base, "peer");
  runGit(base, ["init", "--bare", "-b", "main", bare]);
  runGit(base, ["clone", bare, local]);
  runGit(local, ["config", "user.name", "Test User"]);
  runGit(local, ["config", "user.email", "test@example.com"]);
  await writeFile(join(local, "a.txt"), "v1\n");
  runGit(local, ["add", "a.txt"]);
  runGit(local, ["commit", "-m", "initial"]);
  runGit(local, ["push", "-u", "origin", "main"]);
  runGit(base, ["clone", bare, peer]);
  runGit(peer, ["config", "user.name", "Peer User"]);
  runGit(peer, ["config", "user.email", "peer@example.com"]);
  return { local, bare, peer };
}

async function expectGitError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`Expected GitError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe(code);
  }
}

/** What the person saw for `path` in the status they reviewed. */
function reviewed(
  status: { staged: Entry[]; unstaged: Entry[]; untracked: Entry[]; conflicted: Entry[] },
  path: string,
): { path: string; fingerprint: string } {
  const entry = [
    ...status.unstaged,
    ...status.untracked,
    ...status.staged,
    ...status.conflicted,
  ].find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`${path} is not in the status`);
  return { path, fingerprint: entry.fingerprint };
}
type Entry = { path: string; fingerprint: string };

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("source control git operations", () => {
  it("stages, unstages, and commits only staged files or amends the previous commit", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "changed a\n");
      await writeFile(join(repo, "b.txt"), "new b\n");

      await git.stage({ worktree: repo, paths: ["a.txt"] });
      let status = await git.sourceControlStatus(repo);
      expect(status.staged.map((e) => e.path)).toEqual(["a.txt"]);
      expect(status.untracked.map((e) => e.path)).toEqual(["b.txt"]);

      const stagedDiff = await git.diff({
        worktree: repo,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "index" },
        paths: ["a.txt"],
      });
      expect(stagedDiff.patch).toContain("+changed a");

      const unstagedDiff = await git.diff({
        worktree: repo,
        from: { kind: "index" },
        to: { kind: "working-tree" },
        paths: ["b.txt"],
      });
      expect(unstagedDiff.patch).toContain("+new b");

      const firstCommit = await git.commit({
        worktree: repo,
        message: "only staged",
        expectedHead: status.head,
        stagedOnly: true,
      });
      expect(runGit(repo, ["log", "-1", "--pretty=%s"])).toBe("only staged");

      status = await git.sourceControlStatus(repo);
      expect(status.staged).toEqual([]);
      expect(status.untracked.map((e) => e.path)).toEqual(["b.txt"]);

      await git.stage({ worktree: repo, paths: ["b.txt"] });
      await git.unstage({ worktree: repo, paths: ["b.txt"] });
      status = await git.sourceControlStatus(repo);
      expect(status.staged).toEqual([]);
      expect(status.untracked.map((e) => e.path)).toEqual(["b.txt"]);

      await git.stage({ worktree: repo });
      const amended = await git.commit({
        worktree: repo,
        message: "amended message",
        expectedHead: firstCommit,
        stagedOnly: true,
        amend: true,
      });
      expect(amended).not.toBe(firstCommit);
      expect(runGit(repo, ["log", "-1", "--pretty=%s"])).toBe("amended message");
      expect(runGit(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    } finally {
      await git.close();
    }
  });

  it("restores tracked files on discard and sends untracked files to trash (refusing without trash)", async () => {
    const repo = await createRepo();
    const trashDir = await mkdtemp(join(tmpdir(), "ace-sc-trash-"));
    tempDirs.push(trashDir);
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "staged version\n");
      await git.stage({ worktree: repo, paths: ["a.txt"] });
      await writeFile(join(repo, "a.txt"), "working tree noise\n");
      await writeFile(join(repo, "draft.txt"), "untracked note\n");
      let status = await git.sourceControlStatus(repo);

      // Discarding unstaged change restores working tree to staged index version.
      await git.discard({ worktree: repo, files: [reviewed(status, "a.txt")] });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("staged version\n");

      // Discarding untracked without a trash handler refuses and leaves the file intact.
      status = await git.sourceControlStatus(repo);
      await expectGitError(
        git.discard({ worktree: repo, files: [reviewed(status, "draft.txt")] }),
        "trash_unavailable",
      );
      expect(await readFile(join(repo, "draft.txt"), "utf8")).toBe("untracked note\n");

      // With a trash handler, the untracked file is moved into trash instead of deleted.
      const trashed: string[] = [];
      await git.discard({
        worktree: repo,
        files: [reviewed(status, "draft.txt")],
        trash: async (root, rel) => {
          trashed.push(rel);
          await rename(join(root, rel), join(trashDir, rel));
        },
      });
      expect(trashed).toEqual(["draft.txt"]);
      expect(await readFile(join(trashDir, "draft.txt"), "utf8")).toBe("untracked note\n");
      status = await git.sourceControlStatus(repo);
      expect(status.untracked).toEqual([]);
    } finally {
      await git.close();
    }
  });

  it("refuses to discard a file changed since the person reviewed it, and discards nothing", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "reviewed edit\n");
      await writeFile(join(repo, "b.txt"), "tracked b\n");
      runGit(repo, ["add", "b.txt"]);
      runGit(repo, ["commit", "-m", "b"]);
      await writeFile(join(repo, "b.txt"), "b edit\n");
      const status = await git.sourceControlStatus(repo);
      // The agent (or another tab) writes after the dialog showed the file.
      await writeFile(join(repo, "a.txt"), "reviewed edit plus a newer line\n");
      await expectGitError(
        git.discard({
          worktree: repo,
          files: [reviewed(status, "b.txt"), reviewed(status, "a.txt")],
        }),
        "changed_since_review",
      );
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("reviewed edit plus a newer line\n");
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b edit\n");
      // A file that disappeared since the review is a change too.
      await rm(join(repo, "b.txt"));
      await expectGitError(
        git.discard({ worktree: repo, files: [reviewed(status, "b.txt")] }),
        "changed_since_review",
      );
    } finally {
      await git.close();
    }
  });

  it("discards a staged rename only when its old name is free, trashing the new file first", async () => {
    const repo = await createRepo();
    const trashDir = await mkdtemp(join(tmpdir(), "ace-sc-trash-"));
    tempDirs.push(trashDir);
    const git = new GitService();
    const trash = async (root: string, rel: string) => {
      await rename(join(root, rel), join(trashDir, rel));
    };
    try {
      runGit(repo, ["mv", "a.txt", "b.txt"]);
      // Something new now sits at the old name: restoring `a.txt` would overwrite it.
      await writeFile(join(repo, "a.txt"), "a new file\n");
      let status = await git.sourceControlStatus(repo);
      await expectGitError(
        git.discard({ worktree: repo, files: [reviewed(status, "b.txt")], trash }),
        "path_occupied",
      );
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a new file\n");
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("hello\n");

      // A failing trash leaves the rename exactly as it was.
      await rm(join(repo, "a.txt"));
      status = await git.sourceControlStatus(repo);
      await expectGitError(
        git.discard({
          worktree: repo,
          files: [reviewed(status, "b.txt")],
          trash: async () => {
            throw new GitError("trash_unavailable", "Recently deleted is full");
          },
        }),
        "trash_unavailable",
      );
      expect(runGit(repo, ["status", "--porcelain"])).toBe("R  a.txt -> b.txt");

      await git.discard({ worktree: repo, files: [reviewed(status, "b.txt")], trash });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("hello\n");
      expect(await readFile(join(trashDir, "b.txt"), "utf8")).toBe("hello\n");
      expect(runGit(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      await git.close();
    }
  });

  it("rejects paths that escape the repository or target .git", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await expectGitError(
        git.stage({ worktree: repo, paths: ["../escape.txt"] }),
        "path_outside_repo",
      );
      await expectGitError(
        git.unstage({ worktree: repo, paths: ["/etc/passwd"] }),
        "path_outside_repo",
      );
      await expectGitError(
        git.discard({ worktree: repo, files: [{ path: ".git/config", fingerprint: "missing" }] }),
        "path_outside_repo",
      );
    } finally {
      await git.close();
    }
  });

  it("creates branches and refuses switching when uncommitted changes conflict", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await git.createBranch({ worktree: repo, branch: "feature" });
      await writeFile(join(repo, "a.txt"), "feature change\n");
      runGit(repo, ["add", "a.txt"]);
      runGit(repo, ["commit", "-m", "feature commit"]);

      await expectGitError(
        git.createBranch({ worktree: repo, branch: "feature" }),
        "branch_exists",
      );

      // Edit a.txt locally so switching back to main would overwrite it.
      await writeFile(join(repo, "a.txt"), "uncommitted local edit\n");
      await expectGitError(
        git.switchBranch({ worktree: repo, branch: "main", allowUncommitted: true }),
        "dirty_worktree",
      );
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("uncommitted local edit\n");

      // After discarding, switch succeeds.
      await git.discard({
        worktree: repo,
        files: [reviewed(await git.sourceControlStatus(repo), "a.txt")],
      });
      await git.switchBranch({ worktree: repo, branch: "main", allowUncommitted: true });
      const status = await git.sourceControlStatus(repo);
      expect(status.branch).toBe("main");
    } finally {
      await git.close();
    }
  });

  it("fetches ahead/behind counts, fast-forwards on pull, and refuses divergent branches", async () => {
    const { local, peer } = await createRepoWithRemote();
    const git = new GitService({ transportProtocols: ["file"] });
    try {
      await writeFile(join(peer, "a.txt"), "from peer\n");
      runGit(peer, ["add", "a.txt"]);
      runGit(peer, ["commit", "-m", "peer commit"]);
      runGit(peer, ["push", "origin", "main"]);

      await git.fetch({ worktree: local });
      let status = await git.sourceControlStatus(local);
      expect(status.behind).toBe(1);
      expect(status.ahead).toBe(0);

      await git.pull({ worktree: local });
      status = await git.sourceControlStatus(local);
      expect(status.behind).toBe(0);
      expect(await readFile(join(local, "a.txt"), "utf8")).toBe("from peer\n");

      // Create divergence: one local commit and one remote commit.
      await writeFile(join(local, "local.txt"), "local\n");
      runGit(local, ["add", "local.txt"]);
      runGit(local, ["commit", "-m", "local commit"]);

      await writeFile(join(peer, "peer.txt"), "peer\n");
      runGit(peer, ["add", "peer.txt"]);
      runGit(peer, ["commit", "-m", "divergent peer commit"]);
      runGit(peer, ["push", "origin", "main"]);

      await expectGitError(git.pull({ worktree: local }), "pull_diverged");
      status = await git.sourceControlStatus(local);
      expect(status.ahead).toBe(1);
      expect(status.behind).toBe(1);
    } finally {
      await git.close();
    }
  });

  it("refuses to switch onto a branch that would overwrite an ignored or untracked file", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      runGit(repo, ["switch", "-c", "with-env"]);
      await writeFile(join(repo, ".env"), "TOKEN=committed-by-someone\n");
      runGit(repo, ["add", ".env"]);
      runGit(repo, ["commit", "-m", "track .env"]);
      runGit(repo, ["switch", "main"]);
      await writeFile(join(repo, ".gitignore"), ".env\n");
      runGit(repo, ["add", ".gitignore"]);
      runGit(repo, ["commit", "-m", "ignore .env"]);
      // The person's own secrets, ignored here, tracked on the other branch.
      await writeFile(join(repo, ".env"), "TOKEN=mine\n");

      await expectGitError(
        git.switchBranch({ worktree: repo, branch: "with-env", allowUncommitted: true }),
        "untracked_overwritten",
      );
      expect(await readFile(join(repo, ".env"), "utf8")).toBe("TOKEN=mine\n");
      expect(runGit(repo, ["branch", "--show-current"])).toBe("main");
    } finally {
      await git.close();
    }
  });

  it("refuses a pull whose incoming commits would overwrite an ignored file", async () => {
    const { local, peer } = await createRepoWithRemote();
    const git = new GitService({ transportProtocols: ["file"] });
    try {
      await writeFile(join(local, ".gitignore"), ".env\n");
      runGit(local, ["add", ".gitignore"]);
      runGit(local, ["commit", "-m", "ignore .env"]);
      runGit(local, ["push", "origin", "main"]);
      runGit(peer, ["pull", "origin", "main"]);
      await writeFile(join(peer, ".env"), "TOKEN=from-peer\n");
      runGit(peer, ["add", "-f", ".env"]);
      runGit(peer, ["commit", "-m", "track .env"]);
      runGit(peer, ["push", "origin", "main"]);
      await writeFile(join(local, ".env"), "TOKEN=mine\n");

      await expectGitError(git.pull({ worktree: local }), "untracked_overwritten");
      expect(await readFile(join(local, ".env"), "utf8")).toBe("TOKEN=mine\n");
      expect((await git.sourceControlStatus(local)).behind).toBe(1);
    } finally {
      await git.close();
    }
  });

  it("never commits ace's Recently deleted entries, from commit-all or a staged folder", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await mkdir(join(repo, "docs", ".ace-upload-trash-7"), { recursive: true });
      await writeFile(join(repo, "docs", ".ace-upload-trash-7", "old.md"), "deleted\n");
      await writeFile(join(repo, "docs", "guide.md"), "guide\n");
      await git.stage({ worktree: repo, paths: ["docs"] });
      expect(runGit(repo, ["diff", "--cached", "--name-only"])).toBe("docs/guide.md");
      await git.unstage({ worktree: repo });

      await mkdir(join(repo, ".ace-upload-trash-8"), { recursive: true });
      await writeFile(join(repo, ".ace-upload-trash-8", "gone.txt"), "deleted\n");
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      // No paths and nothing staged: the commit takes every change in the checkout.
      await git.commit({ worktree: repo, message: "everything", expectedHead: head });
      expect(runGit(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("docs/guide.md");
      // A terminal `git add -A` skips them too: the repository's local exclude names them.
      runGit(repo, ["add", "-A"]);
      expect(runGit(repo, ["diff", "--cached", "--name-only"])).toBe("");
    } finally {
      await git.close();
    }
  });

  it("pushes, lists, and pops stashes including untracked files", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await expectGitError(git.stashPop({ worktree: repo }), "stash_empty");

      await writeFile(join(repo, "a.txt"), "wip tracked\n");
      await writeFile(join(repo, "temp.txt"), "wip untracked\n");

      await git.stashPush({
        worktree: repo,
        message: "save work",
        includeUntracked: true,
      });

      let status = await git.sourceControlStatus(repo);
      expect(status.unstaged).toEqual([]);
      expect(status.untracked).toEqual([]);

      const stashes = await git.stashList(repo);
      expect(stashes).toHaveLength(1);
      expect(stashes[0]?.ref).toBe("stash@{0}");
      expect(stashes[0]?.branch).toBe("main");
      expect(stashes[0]?.message).toBe("save work");

      await git.stashPop({ worktree: repo, stash: "stash@{0}" });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("wip tracked\n");
      expect(await readFile(join(repo, "temp.txt"), "utf8")).toBe("wip untracked\n");
      expect(await git.stashList(repo)).toEqual([]);
    } finally {
      await git.close();
    }
  });
  it("leaves ace's Recently deleted entries out of status, Stage all and stashes", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await mkdir(join(repo, ".ace-upload-trash-1"), { recursive: true });
      await writeFile(join(repo, ".ace-upload-trash-1", "gone.txt"), "deleted\n");
      await writeFile(join(repo, "a.txt"), "edited\n");
      await writeFile(join(repo, "new.txt"), "new\n");

      const status = await git.sourceControlStatus(repo);
      expect(status.untracked.map((entry) => entry.path)).toEqual(["new.txt"]);

      await git.stage({ worktree: repo });
      expect(runGit(repo, ["diff", "--cached", "--name-only"]).split("\n")).toEqual([
        "a.txt",
        "new.txt",
      ]);

      await git.stashPush({ worktree: repo, includeUntracked: true });
      expect(await readFile(join(repo, ".ace-upload-trash-1", "gone.txt"), "utf8")).toBe(
        "deleted\n",
      );
      // Still there, and ignored through the repository's local exclude.
      expect(runGit(repo, ["status", "--porcelain", "--ignored"])).toBe("!! .ace-upload-trash-1/");
    } finally {
      await git.close();
    }
  });
});
