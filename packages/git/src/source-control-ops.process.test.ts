import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileFingerprint } from "./file-fingerprint.ts";
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

/** A Recently deleted stand-in: moves the reviewed file into `dir`, as the daemon would. */
function trashInto(dir: string) {
  return async (root: string, path: string, fingerprint: string) => {
    if ((await fileFingerprint(root, path)) !== fingerprint)
      throw new GitError("changed_since_review", "Changed since review");
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await rename(join(root, path), join(dir, path));
  };
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

  it("restores tracked files and keeps what they held in Recently deleted; refuses without it", async () => {
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

      // Without Recently deleted nothing is discarded: the bytes it would replace have no home.
      await expectGitError(
        git.discard({ worktree: repo, files: [reviewed(status, "a.txt")] }),
        "trash_unavailable",
      );
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("working tree noise\n");

      // Discarding an unstaged change restores the staged version; the edit is recoverable.
      await git.discard({
        worktree: repo,
        files: [reviewed(status, "a.txt")],
        trash: trashInto(trashDir),
      });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("staged version\n");
      expect(await readFile(join(trashDir, "a.txt"), "utf8")).toBe("working tree noise\n");

      status = await git.sourceControlStatus(repo);
      await git.discard({
        worktree: repo,
        files: [reviewed(status, "draft.txt")],
        trash: trashInto(trashDir),
      });
      expect(await readFile(join(trashDir, "draft.txt"), "utf8")).toBe("untracked note\n");
      expect((await git.sourceControlStatus(repo)).untracked).toEqual([]);
    } finally {
      await git.close();
    }
  });

  it("a save that lands while the discard runs is never overwritten", async () => {
    const repo = await createRepo();
    const trashDir = await mkdtemp(join(tmpdir(), "ace-sc-trash-"));
    tempDirs.push(trashDir);
    const git = new GitService();
    try {
      runGit(repo, ["add", "a.txt"]);
      await writeFile(join(repo, "b.txt"), "b\n");
      runGit(repo, ["add", "b.txt"]);
      runGit(repo, ["commit", "-m", "b"]);
      await writeFile(join(repo, "a.txt"), "a edit\n");
      await writeFile(join(repo, "b.txt"), "b edit\n");
      const status = await git.sourceControlStatus(repo);
      const move = trashInto(trashDir);

      // An editor saves b.txt after the discard checked it, while a.txt is being moved aside.
      await expectGitError(
        git.discard({
          worktree: repo,
          files: [reviewed(status, "a.txt"), reviewed(status, "b.txt")],
          trash: async (root, path, fingerprint) => {
            if (path === "a.txt") await writeFile(join(root, "b.txt"), "b saved later\n");
            await move(root, path, fingerprint);
          },
        }),
        "changed_since_review",
      );
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b saved later\n");
      // What already moved aside is recoverable, and Git restored nothing over a newer save.
      expect(await readFile(join(trashDir, "a.txt"), "utf8")).toBe("a edit\n");

      // A save that lands at the path after its file moved aside is kept too.
      const again = await git.sourceControlStatus(repo);
      await expectGitError(
        git.discard({
          worktree: repo,
          files: [reviewed(again, "b.txt")],
          trash: async (root, path, fingerprint) => {
            await move(root, path, fingerprint);
            await writeFile(join(root, path), "saved into the gap\n");
          },
        }),
        "changed_since_review",
      );
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("saved into the gap\n");
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
        trash: trashInto(await mkdtemp(join(tmpdir(), "ace-sc-trash-"))),
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
        git.commit({
          worktree: repo,
          message: "only a",
          expectedHead: head,
          stagedOnly: true,
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
      await git.commit({
        worktree: repo,
        message: "only a",
        expectedHead: head,
        stagedOnly: true,
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
        git.commit({
          worktree: repo,
          message: "all",
          expectedHead: head,
          reviewed: [reviewed(status, "a.txt"), reviewed(status, "new.txt")],
        }),
        "changed_since_review",
      );
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);

      status = await git.sourceControlStatus(repo);
      await git.commit({
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

  it("a commit whose HEAD moves underneath it is undone and refused", async () => {
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
          git.commit({
            worktree: repo,
            message: "mine",
            expectedHead: head,
            stagedOnly: true,
            expectedIndex: status.index,
          }),
        ),
        "head_moved",
      );
      // The other commit stands; ours never landed on top of it.
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
        git.commit({
          worktree: repo,
          message: "oops",
          expectedHead: head,
          stagedOnly: true,
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
        git.commit({
          worktree: local,
          message: "reworded",
          expectedHead: head,
          stagedOnly: true,
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

  it("a conflicted stash pop keeps the stash and leaves the conflict in the index", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "stashed line\n");
      await git.stashPush({ worktree: repo, message: "mine" });
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("hello\n");
      await writeFile(join(repo, "a.txt"), "committed line\n");
      runGit(repo, ["commit", "-am", "conflicting"]);

      await expectGitError(git.stashPop({ worktree: repo }), "conflicts");
      const text = await readFile(join(repo, "a.txt"), "utf8");
      expect(text).toContain("committed line");
      expect(text).toContain("stashed line");
      expect(text).toContain("<<<<<<<");
      // Git keeps a stash it could not apply cleanly; nothing of the person's work is lost.
      expect((await git.stashList(repo)).map((stash) => stash.message)).toEqual(["mine"]);
      const status = await git.sourceControlStatus(repo);
      expect(status.conflicted.map((entry) => entry.path)).toEqual(["a.txt"]);
    } finally {
      await git.close();
    }
  });

  it("a cancelled change runs no further Git and moves nothing aside", async () => {
    const repo = await createRepo();
    const trashDir = await mkdtemp(join(tmpdir(), "ace-sc-trash-"));
    tempDirs.push(trashDir);
    const git = new GitService();
    try {
      await writeFile(join(repo, "a.txt"), "edit\n");
      const status = await git.sourceControlStatus(repo);
      const stop = new AbortController();
      stop.abort();
      await expectGitError(
        git.cancellable(stop.signal, () => git.stage({ worktree: repo, paths: ["a.txt"] })),
        "git_cancelled",
      );
      expect(runGit(repo, ["diff", "--cached", "--name-only"])).toBe("");
      await expectGitError(
        git.cancellable(stop.signal, () =>
          git.discard({
            worktree: repo,
            files: [reviewed(status, "a.txt")],
            trash: trashInto(trashDir),
          }),
        ),
        "git_cancelled",
      );
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("edit\n");
    } finally {
      await git.close();
    }
  });

  it("a discard names ace's private entries in the local exclude before it makes the first one", async () => {
    const repo = await createRepo();
    const git = new GitService();
    try {
      await writeFile(join(repo, "draft.txt"), "draft\n");
      const status = await git.sourceControlStatus(repo);
      let excludedFirst = false;
      await git.discard({
        worktree: repo,
        files: [reviewed(status, "draft.txt")],
        // Recently deleted parks the file inside the checkout, as the files service does.
        trash: async (root, path) => {
          excludedFirst = (await readFile(join(root, ".git", "info", "exclude"), "utf8")).includes(
            ".ace-upload-*",
          );
          await mkdir(join(root, ".ace-upload-trash-1"), { recursive: true });
          await rename(join(root, path), join(root, ".ace-upload-trash-1", path));
        },
      });
      expect(excludedFirst).toBe(true);
      // So a terminal's `git add -A` right after never picks it up.
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
