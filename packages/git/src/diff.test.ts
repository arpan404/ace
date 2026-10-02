import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scratch } from "./test-repo.ts";

const service = new GitService();

test("live diffs detect renames, binary files, additions and deletions with exact unusual paths", async () => {
  const oldPath = "old name\n雪.txt";
  const newPath = "new name\n☃.txt";
  const repo = await repository({
    [oldPath]: "rename this\n",
    "deleted.txt": "gone\n",
    "modified.txt": "before\n",
    "binary.bin": Buffer.from([0, 1, 2, 3]),
  });
  const from = await service.createCheckpoint({
    worktree: repo,
    threadId: "diff",
    label: "before",
  });
  await rename(join(repo, oldPath), join(repo, newPath));
  await put(repo, "binary.bin", Buffer.from([0, 9, 8, 7]));
  await put(repo, "modified.txt", "after\nextra\n");
  await rm(join(repo, "deleted.txt"));
  await put(repo, "added\t雪.txt", "new\n");
  const index = await readFile(join(repo, ".git", "index"));
  const result = await service.diff({
    worktree: repo,
    from: { kind: "checkpoint", id: from.id },
    to: { kind: "working-tree" },
  });
  expect(result.entries).toEqual(
    expect.arrayContaining([
      { path: newPath, oldPath, status: "R", additions: 0, deletions: 0, binary: false },
      { path: "binary.bin", status: "M", additions: 0, deletions: 0, binary: true },
      { path: "deleted.txt", status: "D", additions: 0, deletions: 1, binary: false },
      { path: "modified.txt", status: "M", additions: 2, deletions: 1, binary: false },
      { path: "added\t雪.txt", status: "A", additions: 1, deletions: 0, binary: false },
    ]),
  );
  expect(result.entries).toHaveLength(5);
  expect(result.patch).toContain("+after\n+extra\n");
  expect(result.patch).toContain("Binary files");
  expect(result.patch).not.toContain("GIT binary patch");
  expect(result.patch).not.toContain("\0");
  expect(result.truncated).toBe(false);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
});

test("commit and checkpoint diffs work in both directions and live-to-live is empty", async () => {
  const repo = await repository({ "file.txt": "before\n" });
  const before = await service.createCheckpoint({
    worktree: repo,
    threadId: "direction",
    label: "before",
  });
  await put(repo, "file.txt", "after\n");
  const after = await service.createCheckpoint({
    worktree: repo,
    threadId: "direction",
    label: "after",
  });
  const forward = await service.diff({
    worktree: repo,
    from: { kind: "commit", ref: "HEAD" },
    to: { kind: "checkpoint", id: after.id },
  });
  expect(forward.patch).toContain("-before\n+after\n");
  const reverse = await service.diff({
    worktree: repo,
    from: { kind: "working-tree" },
    to: { kind: "checkpoint", id: before.id },
  });
  expect(reverse.patch).toContain("-after\n+before\n");
  const checkpoints = await service.diff({
    worktree: repo,
    from: { kind: "checkpoint", id: before.id },
    to: { kind: "checkpoint", id: after.id },
  });
  expect(checkpoints).toEqual(forward);
  expect(
    await service.diff({
      worktree: repo,
      from: { kind: "working-tree" },
      to: { kind: "working-tree" },
    }),
  ).toEqual({ entries: [], patch: "", truncated: false });
});

test("patch caps bound bytes while preserving complete per-file metadata", async () => {
  const repo = await repository({ "file.txt": "before\n" });
  await put(repo, "file.txt", "雪☃\n".repeat(10_000));
  const args = {
    worktree: repo,
    from: { kind: "commit" as const, ref: "HEAD" },
    to: { kind: "working-tree" as const },
  };
  const full = await service.diff({ ...args, maxPatchBytes: 200_000 });
  const capped = await new GitService({ maxPatchBytes: 257 }).diff(args);
  expect(capped.entries).toEqual([
    { path: "file.txt", status: "M", additions: 10_000, deletions: 1, binary: false },
  ]);
  expect(capped.entries).toEqual(full.entries);
  expect(capped.truncated).toBe(true);
  expect(Buffer.byteLength(capped.patch)).toBeLessThanOrEqual(257);
  expect(capped.patch).not.toContain("\uFFFD");
  expect(full.patch.startsWith(capped.patch)).toBe(true);
  const zero = await service.diff({ ...args, maxPatchBytes: 0 });
  expect(zero.patch).toBe("");
  expect(zero.truncated).toBe(true);
  expect(full.truncated).toBe(false);
  await expect(service.diff({ ...args, maxPatchBytes: -1 })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("custom binary patch configuration and textconv do not inline binary bytes", async () => {
  const repo = await repository({
    "file.bin": Buffer.from([0, 1, 2, 3]),
    ".gitattributes": "*.bin diff=custom\n",
  });
  const directory = await scratch();
  const script = join(directory, "converter.cjs");
  const converted = join(directory, "converted");
  const external = join(directory, "external");
  await writeFile(
    script,
    "require('node:fs').writeFileSync(process.argv[2], 'ran'); process.stdout.write('CONVERTED_CONTENT\\n');",
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  await git(repo, "config", "diff.custom.binary", "true");
  await git(repo, "config", "diff.custom.textconv", `${command} ${JSON.stringify(converted)}`);
  await git(repo, "config", "diff.external", `${command} ${JSON.stringify(external)}`);
  await git(repo, "config", "diff.binary", "true");
  await put(repo, "file.bin", Buffer.from([0, 9, 8, 7]));
  // The configured converter runs for normal Git diffs; ace must bypass it.
  await git(repo, "diff", "--no-ext-diff");
  expect(await readFile(converted, "utf8")).toBe("ran");
  await rm(converted);
  const result = await service.diff({
    worktree: repo,
    from: { kind: "commit", ref: "HEAD" },
    to: { kind: "working-tree" },
  });
  expect(result.entries[0]?.binary).toBe(true);
  expect(result.patch).not.toContain("GIT binary patch");
  expect(result.patch).not.toContain("CONVERTED_CONTENT");
  await expect(readFile(converted)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(external)).rejects.toMatchObject({ code: "ENOENT" });
});

test("unknown commits and non-checkpoint refs fail with typed errors", async () => {
  const repo = await repository();
  await expect(
    service.diff({
      worktree: repo,
      from: { kind: "commit", ref: "no-such-ref" },
      to: { kind: "working-tree" },
    }),
  ).rejects.toMatchObject({ code: "invalid_ref" });
  await expect(
    service.restoreCheckpoint({ worktree: repo, checkpoint: "HEAD" }),
  ).rejects.toMatchObject({ code: "checkpoint_not_found" });
  await git(repo, "update-ref", "refs/ace/checkpoints/fake/1", "HEAD");
  await expect(
    service.restoreCheckpoint({ worktree: repo, checkpoint: "refs/ace/checkpoints/fake/1" }),
  ).rejects.toMatchObject({ code: "checkpoint_not_found" });
  await expect(
    service.createCheckpoint({ worktree: repo, threadId: "../bad", label: "invalid" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
