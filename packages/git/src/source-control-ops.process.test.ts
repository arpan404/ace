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

  it("commits only the index the person reviewed, and a generated message commits as is", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "reviewed\n");
      await git.stage({ worktree: repo, paths: ["a.txt"] });
      const shown = await git.sourceControlStatus(repo);
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      // Another client stages more after the person's view read the status.
      await writeFile(join(repo, "b.txt"), "slipped in\n");
      runGit(repo, ["add", "b.txt"]);
      await expectGitError(
        git.commitReviewed({
          worktree: repo,
          message: "only a",
          expectedHead: head,
          expectedIndex: shown.index,
        }),
        "index_moved",
      );
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);

      runGit(repo, ["reset", "-q", "HEAD", "--", "b.txt"]);
      const again = await git.sourceControlStatus(repo);
      expect(again.index).toBe(shown.index);
      // The message was generated for the staged files; committing it untouched works.
      const draft = await git.writingContext(repo, { kind: "commit", paths: ["a.txt"] });
      await git.commitReviewed({
        worktree: repo,
        message: "only a",
        expectedHead: head,
        expectedIndex: again.index,
        draftFingerprint: draft.fingerprint,
      });
      expect(runGit(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt");
    } finally {
      await git.close();
    }
  });

  it("commit-all commits the reviewed bytes and refuses a file changed since review", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "reviewed\n");
      await writeFile(join(repo, "new.txt"), "new\n");
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      let status = await git.sourceControlStatus(repo);
      await writeFile(join(repo, "a.txt"), "edited after review\n");
      await expectGitError(
        git.commitReviewed({
          worktree: repo,
          message: "all",
          expectedHead: head,
          reviewed: [reviewed(status, "a.txt"), reviewed(status, "new.txt")],
        }),
        "changed_since_review",
      );
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);

      status = await git.sourceControlStatus(repo);
      await git.commitReviewed({
        worktree: repo,
        message: "all",
        expectedHead: head,
        reviewed: [reviewed(status, "a.txt"), reviewed(status, "new.txt")],
      });
      expect(runGit(repo, ["show", "HEAD:a.txt"])).toBe("edited after review");
      expect(runGit(repo, ["show", "HEAD:new.txt"])).toBe("new");
      expect(runGit(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      await git.close();
    }
  });

  it("a commit whose branch moves while Git runs is refused, and no ref is moved back", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      // The person's pre-commit hook commits something else first: HEAD moves mid-commit.
      await writeFile(
        join(repo, ".git", "hooks", "pre-commit"),
        [
          "#!/bin/sh",
          "unset GIT_INDEX_FILE",
          'next=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m sneaky)',
          'git update-ref HEAD "$next"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      await writeFile(join(repo, "a.txt"), "mine\n");
      await git.stage({ worktree: repo, paths: ["a.txt"] });
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      const status = await git.sourceControlStatus(repo);
      await expectGitError(
        git.asPerson(() =>
          git.commitReviewed({
            worktree: repo,
            message: "mine",
            expectedHead: head,
            expectedIndex: status.index,
          }),
        ),
        "head_moved",
      );
      // Git's own compare-and-swap refused: the other commit stands, nothing was rewound, and
      // the person's change is still staged.
      expect(runGit(repo, ["log", "-1", "--format=%s"])).toBe("sneaky");
      expect(runGit(repo, ["diff", "--cached", "--name-only"])).toBe("a.txt");
    } finally {
      await git.close();
    }
  });

  it("refuses to commit ace's private entries that were already staged", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await mkdir(join(repo, ".ace-upload-trash-3"), { recursive: true });
      await writeFile(join(repo, ".ace-upload-trash-3", "x.txt"), "deleted\n");
      runGit(repo, ["add", "-f", ".ace-upload-trash-3/x.txt"]);
      const head = runGit(repo, ["rev-parse", "HEAD"]);
      const status = await git.sourceControlStatus(repo);
      await expectGitError(
        git.commitReviewed({
          worktree: repo,
          message: "oops",
          expectedHead: head,
          expectedIndex: status.index,
        }),
        "private_path_staged",
      );
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      await git.close();
    }
  });

  it("amending a commit any remote already has asks first, even without an upstream", async () => {
    const { local } = await createRepoWithRemote();
    const git = new GitService({ transportProtocols: ["file"] });
    try {
      runGit(local, ["switch", "-q", "-c", "topic"]);
      // Pushed, but no upstream is set for the branch.
      runGit(local, ["push", "-q", "origin", "topic"]);
      const head = runGit(local, ["rev-parse", "HEAD"]);
      const status = await git.sourceControlStatus(local);
      const amend = (amendPublished: boolean) =>
        git.commitReviewed({
          worktree: local,
          message: "reworded",
          expectedHead: head,
          amend: true,
          expectedIndex: status.index,
          amendPublished,
        });
      await expectGitError(amend(false), "amend_published");
      expect(runGit(local, ["rev-parse", "HEAD"])).toBe(head);
      await amend(true);
      expect(runGit(local, ["log", "-1", "--format=%s"])).toBe("reworded");
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
