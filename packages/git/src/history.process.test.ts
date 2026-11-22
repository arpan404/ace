import { rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scratch } from "./test-repo.ts";

const service = new GitService();

test("fileLog follows renames, pages through commits, and reports when output hits the byte cap", async () => {
  const repo = await repository({ "old.ts": "export const a = 1;\n" });
  const firstSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "old.ts", "export const a = 2;\nexport const b = 3;\n");
  await git(repo, "add", "old.ts");
  await git(repo, "commit", "-m", "Update old file");
  const secondSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await rename(join(repo, "old.ts"), join(repo, "renamed.ts"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "Rename old.ts to renamed.ts");
  const thirdSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "renamed.ts", "export const a = 2;\nexport const b = 4;\n");
  await git(repo, "add", "renamed.ts");
  await git(repo, "commit", "-m", "Touch renamed file");
  const fourthSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  const page1 = await service.fileLog({ worktree: repo, path: "renamed.ts", limit: 2, skip: 0 });
  expect(page1.head).toBe(fourthSha);
  expect(page1.capped).toBe(false);
  expect(page1.hasMore).toBe(true);
  expect(page1.nextSkip).toBe(2);
  expect(page1.entries.map((entry) => entry.sha)).toEqual([fourthSha, thirdSha]);
  expect(page1.entries[0]?.path).toBe("renamed.ts");
  expect(page1.entries[1]).toMatchObject({
    sha: thirdSha,
    subject: "Rename old.ts to renamed.ts",
    path: "renamed.ts",
    previousPath: "old.ts",
  });

  const page2 = await service.fileLog({
    worktree: repo,
    path: "renamed.ts",
    limit: 2,
    skip: page1.nextSkip,
  });
  expect(page2.capped).toBe(false);
  expect(page2.hasMore).toBe(false);
  expect(page2.nextSkip).toBeUndefined();
  expect(page2.entries.map((entry) => entry.sha)).toEqual([secondSha, firstSha]);
  expect(page2.entries[0]?.path).toBe("old.ts");
  expect(page2.entries[1]?.path).toBe("old.ts");

  const capped = await service.fileLog({
    worktree: repo,
    path: "renamed.ts",
    limit: 10,
    maxBytes: 150,
  });
  expect(capped.capped).toBe(true);
  expect(capped.entries.length).toBeLessThan(4);
});

test("fileLog returns an empty history on an unborn repository or untracked file", async () => {
  const emptyRepo = await scratch();
  await git(emptyRepo, "init");
  await put(emptyRepo, "draft.ts", "export const x = 1;\n");

  const unborn = await service.fileLog({ worktree: emptyRepo, path: "draft.ts" });
  expect(unborn).toEqual({ entries: [], hasMore: false, capped: false, head: null });

  const trackedRepo = await repository({ "tracked.ts": "one\n" });
  await put(trackedRepo, "untracked.ts", "two\n");
  const untracked = await service.fileLog({ worktree: trackedRepo, path: "untracked.ts" });
  expect(untracked.entries).toEqual([]);
  expect(untracked.hasMore).toBe(false);
  expect(untracked.capped).toBe(false);
  expect(untracked.head).toMatch(/^[0-9a-f]{40,64}$/);
});

test("fileBlame blames only the requested line range, marks uncommitted lines null, and caps output", async () => {
  const repo = await repository({ "app.ts": "line 1\nline 2\nline 3\nline 4\n" });
  const firstSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "app.ts", "line 1\nline 2 edited\nline 3\nline 4\n");
  await git(repo, "add", "app.ts");
  await git(repo, "commit", "-m", "Edit line 2");
  const secondSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  // Working-tree edit on line 3 (not committed yet)
  await put(repo, "app.ts", "line 1\nline 2 edited\nline 3 dirty\nline 4\n");

  const blamed = await service.fileBlame({
    worktree: repo,
    path: "app.ts",
    startLine: 2,
    endLine: 4,
  });
  expect(blamed.head).toBe(secondSha);
  expect(blamed.capped).toBe(false);
  expect(blamed.lines).toEqual([
    { line: 2, sha: secondSha },
    { line: 3, sha: null },
    { line: 4, sha: firstSha },
  ]);
  expect(blamed.commits.find((c) => c.sha === secondSha)).toMatchObject({
    sha: secondSha,
    shortSha: secondSha.slice(0, 7),
    subject: "Edit line 2",
  });
  expect(blamed.commits.find((c) => c.sha === firstSha)).toBeDefined();

  // Untracked file returns empty lines without throwing
  await put(repo, "brand-new.ts", "hello\n");
  const untracked = await service.fileBlame({
    worktree: repo,
    path: "brand-new.ts",
    startLine: 1,
    endLine: 10,
  });
  expect(untracked.lines).toEqual([]);
  expect(untracked.commits).toEqual([]);
  expect(untracked.capped).toBe(false);

  // Byte cap stops cleanly and sets capped: true
  const capped = await service.fileBlame({
    worktree: repo,
    path: "app.ts",
    startLine: 1,
    endLine: 4,
    maxBytes: 120,
  });
  expect(capped.capped).toBe(true);
  expect(capped.lines.length).toBeLessThan(4);
});

test("diffCommit diffs a root commit, a regular commit, and a rename commit", async () => {
  const repo = await repository({ "a.ts": "export const value = 1;\n" });
  const rootSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "a.ts", "export const value = 2;\n");
  await git(repo, "add", "a.ts");
  await git(repo, "commit", "-m", "Change value to 2");
  const editSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await rename(join(repo, "a.ts"), join(repo, "b.ts"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "Rename a.ts to b.ts");
  const renameSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  const rootDiff = await service.diffCommit({
    worktree: repo,
    commit: rootSha,
    paths: ["a.ts"],
  });
  expect(rootDiff.truncated).toBe(false);
  expect(rootDiff.patch).toContain("+export const value = 1;");

  const editDiff = await service.diffCommit({
    worktree: repo,
    commit: editSha,
    paths: ["a.ts"],
  });
  expect(editDiff.patch).toContain("-export const value = 1;");
  expect(editDiff.patch).toContain("+export const value = 2;");

  const renameDiff = await service.diffCommit({
    worktree: repo,
    commit: renameSha,
    paths: ["b.ts", "a.ts"],
  });
  expect(renameDiff.patch).toContain("rename from a.ts");
  expect(renameDiff.patch).toContain("rename to b.ts");
});
