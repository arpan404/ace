import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("stages, unstages, and commits exactly the index, leaving unstaged work out", async () => {
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

      // A staged-only commit is what the index holds now, not the working tree: a file staged
      // and then edited again commits its staged text.
      await writeFile(join(repo, "b.txt"), "staged b\n");
      await git.stage({ worktree: repo, paths: ["b.txt"] });
      await writeFile(join(repo, "b.txt"), "staged b, then edited\n");
      await git.commit({
        worktree: repo,
        message: "index only",
        expectedHead: firstCommit,
        stagedOnly: true,
      });
      expect(runGit(repo, ["show", "HEAD:b.txt"])).toBe("staged b");
      expect(runGit(repo, ["diff", "--cached", "--name-only"])).toBe("");
      expect(runGit(repo, ["diff", "--name-only"])).toBe("b.txt");
      // Nothing staged: a staged-only commit refuses rather than taking the working tree.
      await expectGitError(
        git.commit({
          worktree: repo,
          message: "nothing",
          expectedHead: runGit(repo, ["rev-parse", "HEAD"]),
          stagedOnly: true,
        }),
        "nothing_to_commit",
      );
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
        git.stage({ worktree: repo, paths: [".git/config"] }),
        "path_outside_repo",
      );
    } finally {
      await git.close();
    }
  });

  it("stages names that only look unusual, and refuses real traversal and absolute paths", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await mkdir(join(repo, "dir"), { recursive: true });
      await writeFile(join(repo, "..notes"), "notes\n");
      await writeFile(join(repo, "dir", "..config"), "config\n");
      await writeFile(join(repo, "dir", "a..b.txt"), "dots\n");
      // A name that reads like pathspec magic is only ever that file.
      await writeFile(join(repo, ":(glob)*.txt"), "literal\n");
      await writeFile(join(repo, "other.txt"), "other\n");
      await git.stage({
        worktree: repo,
        paths: ["..notes", "dir/..config", "dir/a..b.txt", ":(glob)*.txt"],
      });
      expect(runGit(repo, ["diff", "--cached", "--name-only"]).split("\n").toSorted()).toEqual(
        ["..notes", ":(glob)*.txt", "dir/..config", "dir/a..b.txt"].toSorted(),
      );
      for (const path of ["..", "../outside.txt", "dir/../../outside.txt", "dir/..", "/etc/passwd"])
        await expectGitError(git.stage({ worktree: repo, paths: [path] }), "path_outside_repo");
    } finally {
      await git.close();
    }
  });

  it("fetch only ever writes remote-tracking refs, whatever refspec the config names", async () => {
    const { local, peer } = await createRepoWithRemote();
    const git = new GitService({ transportProtocols: ["file"] });
    try {
      // A hostile config that would make a plain `git fetch` overwrite local branches.
      runGit(local, [
        "config",
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/heads/*",
      ]);
      await writeFile(join(local, "mine.txt"), "mine\n");
      runGit(local, ["add", "mine.txt"]);
      runGit(local, ["commit", "-m", "local work"]);
      const mine = runGit(local, ["rev-parse", "refs/heads/main"]);
      await writeFile(join(peer, "theirs.txt"), "theirs\n");
      runGit(peer, ["add", "theirs.txt"]);
      runGit(peer, ["commit", "-m", "remote work"]);
      runGit(peer, ["push", "-q", "origin", "main"]);
      runGit(peer, ["push", "-q", "origin", "main:evil"]);
      const theirs = runGit(peer, ["rev-parse", "HEAD"]);
      runGit(local, ["switch", "-q", "--detach"]);

      await git.fetch({ worktree: local });
      expect(runGit(local, ["rev-parse", "refs/heads/main"])).toBe(mine);
      expect(runGit(local, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
        "refs/heads/main",
      );
      expect(runGit(local, ["rev-parse", "refs/remotes/origin/main"])).toBe(theirs);
      expect(runGit(local, ["rev-parse", "refs/remotes/origin/evil"])).toBe(theirs);
    } finally {
      await git.close();
    }
  });

  it("fetch updates ahead and behind without touching the checkout", async () => {
    const { local, peer } = await createRepoWithRemote();
    const git = new GitService({ transportProtocols: ["file"] });
    try {
      await writeFile(join(peer, "a.txt"), "from peer\n");
      runGit(peer, ["add", "a.txt"]);
      runGit(peer, ["commit", "-m", "peer commit"]);
      runGit(peer, ["push", "origin", "main"]);
      await writeFile(join(local, "local.txt"), "local\n");
      runGit(local, ["add", "local.txt"]);
      runGit(local, ["commit", "-m", "local commit"]);

      await git.fetch({ worktree: local });
      const status = await git.sourceControlStatus(local);
      expect(status.behind).toBe(1);
      expect(status.ahead).toBe(1);
      expect(await readFile(join(local, "a.txt"), "utf8")).toBe("v1\n");
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

  it("a plain commit refuses ace's private entries that were staged by hand", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await mkdir(join(repo, ".ace-upload-trash-4"), { recursive: true });
      await writeFile(join(repo, ".ace-upload-trash-4", "x.txt"), "deleted\n");
      runGit(repo, ["add", "-f", ".ace-upload-trash-4/x.txt"]);
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      await expectGitError(
        git.commit({ worktree: repo, message: "oops", expectedHead: head, stagedOnly: true }),
        "private_path_staged",
      );
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      await git.close();
    }
  });

  it("leaves ace's Recently deleted entries out of status and Stage all", async () => {
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

      // Still there, and ignored through the repository's local exclude.
      expect(runGit(repo, ["status", "--porcelain", "--ignored"])).toContain(
        "!! .ace-upload-trash-1/",
      );
    } finally {
      await git.close();
    }
  });
});
