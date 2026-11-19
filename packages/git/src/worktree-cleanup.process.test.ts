import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

test("cleanup preserves unpublished commits and removes only the reviewed pushed branch", async () => {
  const repo = await repository();
  const service = new GitService();
  const path = join(dirname(repo), "finished");
  try {
    await service.createWorktree({ repo, path, branch: "finished", baseRef: "HEAD" });
    // A commit only this branch has: deleting the branch would lose it until it is pushed.
    await git(path, "commit", "--quiet", "--allow-empty", "-m", "Finished work");
    const unpublished = await service.inspectWorktreeCleanup(repo, path);
    expect(unpublished.unpushed).toBe(true);
    await expect(
      service.cleanupWorktree({
        repo,
        path,
        fingerprint: unpublished.fingerprint,
        force: false,
        removeBranch: true,
      }),
    ).rejects.toMatchObject({ code: "dirty_worktree" });
    await access(path);
    const head = await scalar(path, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/remotes/origin/finished", head);
    const reviewed = await service.inspectWorktreeCleanup(repo, path);
    expect(reviewed.unpushed).toBe(false);
    expect(reviewed.bytes).toBeGreaterThan(0);
    await service.cleanupWorktree({
      repo,
      path,
      fingerprint: reviewed.fingerprint,
      force: false,
      removeBranch: true,
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.branchHead({ repo, branch: "finished" })).toBeUndefined();
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
  } finally {
    await service.close();
  }
});

test("a dirty worktree changed after forced review is preserved", async () => {
  const repo = await repository();
  const service = new GitService();
  const path = join(dirname(repo), "dirty");
  try {
    await service.createWorktree({ repo, path, branch: "dirty", baseRef: "HEAD" });
    await put(path, "tracked.txt", "first edit\n");
    const reviewed = await service.inspectWorktreeCleanup(repo, path);
    expect(reviewed.dirty).toBe(true);
    await put(path, "tracked.txt", "second edit\n");
    await expect(
      service.cleanupWorktree({
        repo,
        path,
        fingerprint: reviewed.fingerprint,
        force: true,
        removeBranch: false,
      }),
    ).rejects.toMatchObject({ code: "head_moved" });
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("second edit\n");
    const fresh = await service.inspectWorktreeCleanup(repo, path);
    await service.cleanupWorktree({
      repo,
      path,
      fingerprint: fresh.fingerprint,
      force: true,
      removeBranch: false,
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.branchHead({ repo, branch: "dirty" })).toBeDefined();
  } finally {
    await service.close();
  }
});

test("cleanup inspection and removal never execute repository helpers", async () => {
  const repo = await repository();
  const service = new GitService();
  const path = join(dirname(repo), "protected");
  const marker = join(dirname(repo), "helper-ran");
  try {
    await service.createWorktree({ repo, path, branch: "protected", baseRef: "HEAD" });
    await git(repo, "config", "core.fsmonitor", `touch '${marker}'`);
    await git(repo, "config", "filter.trap.clean", `touch '${marker}'`);
    await put(path, ".gitattributes", "tracked.txt filter=trap\n");
    const reviewed = await service.inspectWorktreeCleanup(repo, path);
    await service.cleanupWorktree({
      repo,
      path,
      fingerprint: reviewed.fingerprint,
      force: true,
      removeBranch: false,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test.each([false, true])(
  "cleanup compares full trees of diverged commits when submodule diffs are ignored (same tree: %s)",
  async (sameTree) => {
    const repo = await repository();
    const source = await repository({ "nested.txt": "first revision\n" });
    const first = await scalar(source, "rev-parse", "HEAD");
    await put(source, "nested.txt", "second revision\n");
    await git(source, "commit", "-am", "Advance nested revision");
    const second = await scalar(source, "rev-parse", "HEAD");
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${first},nested`);
    await git(repo, "commit", "-m", "Track nested revision");
    const base = await scalar(repo, "rev-parse", "HEAD");
    const main = await scalar(repo, "commit-tree", "HEAD^{tree}", "-p", base, "-m", "Main");
    await git(repo, "update-ref", "refs/remotes/origin/main", main);
    await git(repo, "config", "diff.ignoreSubmodules", "all");
    const service = new GitService();
    const path = join(dirname(repo), "diverged");
    try {
      await service.createWorktree({ repo, path, branch: "diverged", baseRef: base });
      if (!sameTree) await git(path, "update-index", "--cacheinfo", `160000,${second},nested`);
      await git(path, "commit", "--allow-empty", "-m", "Topic");
      const head = await scalar(path, "rev-parse", "HEAD");
      // The configured diff reports equality even when the tracked gitlink changed.
      await git(repo, "diff", "--quiet", head, main, "--");
      const reviewed = await service.inspectWorktreeCleanup(repo, path);
      expect(reviewed).toMatchObject({ dirty: false, unpushed: true, mergedIntoMain: sameTree });
      const removal = service.cleanupWorktree({
        repo,
        path,
        fingerprint: reviewed.fingerprint,
        force: false,
        removeBranch: true,
      });
      if (sameTree) {
        await removal;
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await service.branchHead({ repo, branch: "diverged" })).toBeUndefined();
      } else {
        await expect(removal).rejects.toMatchObject({ code: "dirty_worktree" });
        await access(path);
        expect(await service.branchHead({ repo, branch: "diverged" })).toBe(head);
      }
    } finally {
      await service.close();
    }
  },
);
