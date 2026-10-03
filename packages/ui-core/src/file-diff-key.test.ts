import type { FileChange } from "@ace/protocol";
import { expect, test } from "vitest";
import { contentHash } from "./content-hash.ts";
import { diffFile, fileDiffKey } from "./turns.ts";

const edit = (oldText: string, newText: string): FileChange => ({
  kind: "update",
  path: "src/retry.ts",
  oldText,
  newText,
});

test("a file's diff key follows its content: same edits, same key; any changed text, new key", () => {
  const a = fileDiffKey({ path: "src/retry.ts", changes: [edit("a\n", "b\n")] }, contentHash);
  const same = fileDiffKey({ path: "src/retry.ts", changes: [edit("a\n", "b\n")] }, contentHash);
  const newer = fileDiffKey({ path: "src/retry.ts", changes: [edit("a\n", "c\n")] }, contentHash);
  const older = fileDiffKey({ path: "src/retry.ts", changes: [edit("z\n", "b\n")] }, contentHash);
  const moved = fileDiffKey({ path: "src/retry2.ts", changes: [edit("a\n", "b\n")] }, contentHash);
  expect(same).toBe(a);
  expect(new Set([a, newer, older, moved]).size).toBe(4);
});

test("chained full-text edits of one file diff as one before/after", () => {
  const diff = diffFile({
    path: "src/retry.ts",
    changes: [edit("one\ntwo\n", "one\n2\n"), edit("one\n2\n", "one\n2\nthree\n")],
  });
  expect(diff.additions).toBe(2);
  expect(diff.deletions).toBe(1);
  expect(diff.status).toBe("modified");
});
