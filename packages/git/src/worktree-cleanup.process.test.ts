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
    const head = await scalar(repo, "rev-parse", "HEAD");
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
