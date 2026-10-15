import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

const service = new GitService();

test("cleanup completes after the worktree folder was deleted by hand", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "deleted by hand");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "gone" });
  await rm(path, { recursive: true, force: true });
  await service.removeWorktree({ repo, path });
  expect((await service.listWorktrees(repo)).map((tree) => tree.branch)).toEqual(["main"]);
  // Only that registration went: the branch and its commits are untouched.
  expect(await service.branchHead({ repo, branch: "gone" })).toBe(
    await scalar(repo, "rev-parse", "HEAD"),
  );
});

test("a branch held by a hand-deleted worktree can start a new worktree", async () => {
  const repo = await repository();
  const first = join(dirname(repo), "first");
  await service.createWorktree({ repo, path: first, baseRef: "HEAD", branch: "feature" });
  await rm(first, { recursive: true, force: true });
  const second = join(dirname(repo), "second");
  const created = await service.createWorktree({
    repo,
    path: second,
    baseRef: "HEAD",
    branch: "feature",
    reuseBranch: true,
  });
  expect(created).toMatchObject({ branch: "feature" });
  expect((await service.listWorktrees(repo)).map((tree) => tree.branch)).toEqual([
    "main",
    "feature",
  ]);
});

test("removing a missing path that was never a worktree still fails as worktree_not_found", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "never registered");
  await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
    code: "worktree_not_found",
  });
});

test("a worktree whose only extra content is ignored node_modules is removed without force", async () => {
  const repo = await repository({ ".gitignore": "node_modules/\n", "tracked.txt": "x\n" });
  const path = join(dirname(repo), "set up");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "deps" });
  await put(path, "node_modules/left-pad/index.js", "module.exports = 1;\n");
  await service.removeWorktree({ repo, path });
  expect((await service.listWorktrees(repo)).map((tree) => tree.branch)).toEqual(["main"]);
});

test("cleanup sees a worktree with ignored files and no new commits as safe in a repository with no remote", async () => {
  const repo = await repository({ ".gitignore": "node_modules/\n", "tracked.txt": "x\n" });
  const path = join(dirname(repo), "no remote");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "local-only" });
  await put(path, "node_modules/dep/index.js", "1\n");
  const state = await service.inspectWorktreeCleanup(repo, path);
  expect(state).toMatchObject({ dirty: false, unpushed: false });
  await service.cleanupWorktree({
    repo,
    path,
    fingerprint: state.fingerprint,
    force: false,
    removeBranch: true,
  });
  expect((await service.listWorktrees(repo)).map((tree) => tree.branch)).toEqual(["main"]);
});

test("cleanup still sees commits no other branch has as unpushed", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "own commits");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "work" });
  await git(path, "commit", "--quiet", "--allow-empty", "-m", "Only here");
  expect(await service.inspectWorktreeCleanup(repo, path)).toMatchObject({ unpushed: true });
});
