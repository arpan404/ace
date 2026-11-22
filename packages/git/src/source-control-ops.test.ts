import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

      // Discarding unstaged change restores working tree to staged index version.
      await git.discard({ worktree: repo, paths: ["a.txt"] });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("staged version\n");

      // Discarding untracked without a trash handler refuses and leaves the file intact.
      await expectGitError(
        git.discard({ worktree: repo, paths: ["draft.txt"] }),
        "trash_unavailable",
      );
      expect(await readFile(join(repo, "draft.txt"), "utf8")).toBe("untracked note\n");

      // With a trash handler, the untracked file is moved into trash instead of deleted.
      const trashed: string[] = [];
      await git.discard({
        worktree: repo,
        paths: ["draft.txt"],
        trash: async (root, rel) => {
          trashed.push(rel);
          await rename(join(root, rel), join(trashDir, rel));
        },
      });
      expect(trashed).toEqual(["draft.txt"]);
      expect(await readFile(join(trashDir, "draft.txt"), "utf8")).toBe("untracked note\n");
      const status = await git.sourceControlStatus(repo);
      expect(status.untracked).toEqual([]);
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
        git.discard({ worktree: repo, paths: [".git/config"] }),
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
      await git.discard({ worktree: repo, paths: ["a.txt"] });
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
});
