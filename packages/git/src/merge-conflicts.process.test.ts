import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import type { GitConflictFile } from "@ace/protocol";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

const service = new GitService();
afterAll(() => service.close());

/** `main` and a PR head that both changed the same lines since their merge base. */
async function diverged() {
  const root = await repository({
    "shared.txt": "one\ntwo\nthree\n",
    "image.bin": Buffer.from([0, 1, 2]),
    "removed.txt": "kept on main\n",
  });
  await git(root, "branch", "-M", "main");
  await git(root, "switch", "--quiet", "-c", "pr");
  await put(root, "shared.txt", "one\nPR two\nthree\n");
  await put(root, "image.bin", Buffer.from([0, 9, 9]));
  await git(root, "rm", "--quiet", "removed.txt");
  await git(root, "commit", "--quiet", "-am", "PR work");
  await git(root, "switch", "--quiet", "main");
  await put(root, "shared.txt", "one\nmain two\nthree\n");
  await put(root, "image.bin", Buffer.from([0, 7, 7]));
  await put(root, "removed.txt", "changed on main\n");
  await git(root, "commit", "--quiet", "-am", "Main work");
  const base = await scalar(root, "rev-parse", "HEAD");
  await git(root, "switch", "--quiet", "pr");
  const head = await scalar(root, "rev-parse", "HEAD");
  const start = () =>
    service.startMerge({
      worktree: root,
      revision: base,
      expectedHead: head,
      message: "Merge main into pr",
    });
  return { root, base, head, start };
}

const file = (files: readonly GitConflictFile[], path: string) => {
  const found = files.find((entry) => entry.path === path);
  if (!found) throw new Error(`${path} isn't listed`);
  return found;
};
const revisionOf = (entry: GitConflictFile) =>
  entry.content.kind === "text" ? entry.content.revision : "";

test("merging a diverged base lists each conflicted file with its ours, base and theirs hunks", async () => {
  const { root, head, start } = await diverged();
  expect(await start()).toBe("conflicts");
  const conflicts = await service.conflicts(root);
  expect(conflicts).toMatchObject({ head, merging: true, dirty: false, truncated: false });
  expect(conflicts.files.map((entry) => entry.path)).toEqual([
    "image.bin",
    "removed.txt",
    "shared.txt",
  ]);
  const shared = file(conflicts.files, "shared.txt");
  expect(shared.stages).toEqual({ base: true, ours: true, theirs: true });
  expect(shared.content).toMatchObject({
    kind: "text",
    segments: [
      { kind: "text", text: "one\n" },
      { kind: "conflict", ours: "PR two\n", base: "two\n", theirs: "main two\n" },
      { kind: "text", text: "three\n" },
    ],
  });
  expect(file(conflicts.files, "image.bin").content).toEqual({
    kind: "unavailable",
    reason: "binary",
  });
  expect(file(conflicts.files, "removed.txt").stages).toEqual({
    base: true,
    ours: false,
    theirs: true,
  });
});

test("resolving every hunk by hand stages the file, and the merge commits with both parents", async () => {
  const { root, base, head, start } = await diverged();
  await start();
  await expect(
    service.commitMerge({ worktree: root, expectedHead: head, message: "Merge main into pr" }),
  ).rejects.toMatchObject({ code: "conflicts" });
  const shared = file((await service.conflicts(root)).files, "shared.txt");
  await expect(
    service.writeResolution({
      worktree: root,
      path: "shared.txt",
      content: "one\nlost\nthree\n",
      revision: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "head_moved" });
  expect(
    await service.writeResolution({
      worktree: root,
      path: "shared.txt",
      content: "one\nPR two and main two\nthree\n",
      revision: revisionOf(shared),
    }),
  ).toEqual({ staged: true });
  await service.takeSide({ worktree: root, path: "image.bin", side: "theirs" });
  await service.takeSide({ worktree: root, path: "removed.txt", side: "ours" });
  const resolved = await service.conflicts(root);
  expect(resolved).toMatchObject({ merging: true, files: [] });
  const merge = await service.commitMerge({
    worktree: root,
    expectedHead: head,
    message: "Merge main into pr",
  });
  expect(await scalar(root, "rev-parse", `${merge}^1`, `${merge}^2`)).toBe(`${head}\n${base}`);
  expect(await scalar(root, "show", `${merge}:shared.txt`)).toBe("one\nPR two and main two\nthree");
  expect(await git(root, "show", `${merge}:image.bin`)).toEqual(Buffer.from([0, 7, 7]));
  await expect(access(join(root, "removed.txt"))).rejects.toThrow();
  expect(await service.conflicts(root)).toMatchObject({ merging: false, files: [] });
});

test("a write that leaves a hunk keeps the file unmerged with the hunks still to resolve", async () => {
  const { root, start } = await diverged();
  await start();
  const shared = file((await service.conflicts(root)).files, "shared.txt");
  if (shared.content.kind !== "text") throw new Error("shared.txt should be text");
  const kept = shared.content.segments
    .map((segment) =>
      segment.kind === "text"
        ? segment.text
        : `${segment.markers.ours}${segment.ours}${segment.markers.separator}${segment.theirs}${segment.markers.theirs}`,
    )
    .join("");
  expect(
    await service.writeResolution({
      worktree: root,
      path: "shared.txt",
      content: `${kept}appended\n`,
      revision: revisionOf(shared),
    }),
  ).toEqual({ staged: false });
  const after = file((await service.conflicts(root)).files, "shared.txt");
  expect(after.content).toMatchObject({
    kind: "text",
    segments: [{ text: "one\n" }, { kind: "conflict", base: null }, { text: "three\nappended\n" }],
  });
  expect(revisionOf(after)).toBe(
    createHash("sha256")
      .update(await readFile(join(root, "shared.txt")))
      .digest("hex"),
  );
});

test("a merge never starts over uncommitted changes or a moved HEAD, and touches nothing", async () => {
  const { root, base, head, start } = await diverged();
  await put(root, "shared.txt", "my own edit\n");
  await expect(start()).rejects.toMatchObject({ code: "dirty_worktree" });
  expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("my own edit\n");
  await git(root, "checkout", "--", "shared.txt");
  await expect(
    service.startMerge({ worktree: root, revision: base, expectedHead: base, message: "Merge" }),
  ).rejects.toMatchObject({ code: "head_moved" });
  expect(await service.conflicts(root)).toMatchObject({ head, merging: false, files: [] });
});

test("abort puts the checkout back at HEAD with the PR's own files", async () => {
  const { root, head, start } = await diverged();
  await start();
  await service.abortMerge(root);
  expect(await service.conflicts(root)).toMatchObject({ head, merging: false, dirty: false });
  expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("one\nPR two\nthree\n");
  await expect(service.abortMerge(root)).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a base the head already contains is up to date and starts no merge", async () => {
  const { root, head } = await diverged();
  const parent = await scalar(root, "rev-parse", "HEAD~1");
  expect(
    await service.startMerge({
      worktree: root,
      revision: parent,
      expectedHead: head,
      message: "Merge",
    }),
  ).toBe("up_to_date");
  expect(await service.conflicts(root)).toMatchObject({ merging: false });
});

test("a base that merges cleanly is staged and waits for its commit", async () => {
  const root = await repository({ "a.txt": "a\n", "b.txt": "b\n" });
  await git(root, "branch", "-M", "main");
  await git(root, "switch", "--quiet", "-c", "pr");
  await put(root, "a.txt", "PR a\n");
  await git(root, "commit", "--quiet", "-am", "PR");
  await git(root, "switch", "--quiet", "main");
  await put(root, "b.txt", "main b\n");
  await git(root, "commit", "--quiet", "-am", "Main");
  const base = await scalar(root, "rev-parse", "HEAD");
  await git(root, "switch", "--quiet", "pr");
  const head = await scalar(root, "rev-parse", "HEAD");
  expect(
    await service.startMerge({ worktree: root, revision: base, expectedHead: head, message: "M" }),
  ).toBe("merged");
  expect(await service.conflicts(root)).toMatchObject({ merging: true, files: [] });
  expect(await scalar(root, "rev-parse", "HEAD")).toBe(head);
});
