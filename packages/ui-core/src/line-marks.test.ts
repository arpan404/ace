import { expect, test } from "vitest";
import { gitPatchFiles } from "./git-patch.ts";
import { lineMarks } from "./line-marks.ts";

const rowsOf = (hunks: string) =>
  gitPatchFiles(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${hunks}`)[0]?.rows ?? [];

test("new lines read as added, lines replacing removed ones as modified", () => {
  const rows = rowsOf("@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+extra\n tail\n");
  expect([...lineMarks(rows)]).toEqual([
    [2, "modified"],
    [3, "added"],
  ]);
});

test("a removal marks the line that now follows it, or the last line at the end", () => {
  expect([...lineMarks(rowsOf("@@ -1,3 +1,2 @@\n one\n-two\n three\n"))]).toEqual([[2, "removed"]]);
  expect([...lineMarks(rowsOf("@@ -1,2 +1,1 @@\n one\n-two\n"))]).toEqual([[1, "removed"]]);
});

test("marks keep the file's own line numbers across hunks", () => {
  const rows = rowsOf("@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -40,2 +40,3 @@\n x\n+y\n z\n");
  expect([...lineMarks(rows)]).toEqual([
    [2, "modified"],
    [41, "added"],
  ]);
});
