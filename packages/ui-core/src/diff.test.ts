import { describe, expect, test } from "vitest";
import { diffTexts, fold, pairRows, parseUnifiedDiff, readDiffText, type DiffRow } from "./diff.ts";
import { changeStat } from "./file-changes.ts";

const text = (rows: readonly DiffRow[]) =>
  rows.map((row) =>
    row.kind === "fold"
      ? `… ${row.count ?? "?"}${row.lines ? " (expandable)" : ""}`
      : `${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}${row.old ?? "_"}/${row.new ?? "_"} ${row.text}`,
  );

test("a one-line edit in a long file keeps three lines of context and folds the rest", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 10", "line ten");
  const rows = fold(diffTexts(before, after));
  expect(text(rows)).toEqual([
    "… 6 (expandable)",
    " 7/7 line 7",
    " 8/8 line 8",
    " 9/9 line 9",
    "-10/_ line 10",
    "+_/10 line ten",
    " 11/11 line 11",
    " 12/12 line 12",
    " 13/13 line 13",
    "… 7 (expandable)",
  ]);
  const hidden = rows[0];
  expect(hidden?.kind === "fold" && hidden.lines?.map((line) => line.text)).toEqual([
    "line 1",
    "line 2",
    "line 3",
    "line 4",
    "line 5",
    "line 6",
  ]);
});

test("inserted lines shift new-side numbers but keep old-side numbers", () => {
  const rows = diffTexts("a\nb\nc\n", "a\nx\ny\nb\nc\n");
  expect(text(rows)).toEqual([" 1/1 a", "+_/2 x", "+_/3 y", " 2/4 b", " 3/5 c"]);
});

test("a short unchanged run between two edits is shown, not folded", () => {
  const rows = fold(diffTexts("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n"));
  expect(rows.some((row) => row.kind === "fold")).toBe(false);
});

test("a provider patch shows the gap before each hunk as unchanged lines that cannot expand", () => {
  const rows = parseUnifiedDiff(
    [
      "--- a/outbox.ts",
      "+++ b/outbox.ts",
      "@@ -18,3 +18,3 @@ class Outbox {",
      "   resume() {",
      "-    clear();",
      "+    keep();",
      "   }",
      "@@ -40,2 +40,3 @@",
      "   push(m) {",
      "+    trim();",
      "   }",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  expect(text(rows)).toEqual([
    "… 17",
    " 18/18   resume() {",
    "-19/_     clear();",
    "+_/19     keep();",
    " 20/20   }",
    "… 19",
    " 40/40   push(m) {",
    "+_/41     trim();",
    " 41/42   }",
  ]);
});

test("split layout lines a change's removed and added lines up side by side", () => {
  const pairs = pairRows(diffTexts("keep\nold 1\nold 2\nend\n", "keep\nnew 1\nend\n"));
  expect(
    pairs.map((pair) =>
      pair.kind === "pair" ? [pair.left?.text ?? "", pair.right?.text ?? ""] : ["fold"],
    ),
  ).toEqual([
    ["keep", "keep"],
    ["old 1", "new 1"],
    ["old 2", ""],
    ["end", "end"],
  ]);
});

test("a full-text edit counts the lines that changed, not the size of the file", () => {
  const before = "one\ntwo\nthree\nfour\n";
  const after = "one\n2\nthree\nfour\nfive\n";
  expect(changeStat({ path: "a.ts", kind: "update", oldText: before, newText: after })).toEqual({
    added: 2,
    removed: 1,
  });
});

describe("a diff someone wrote, read line by line", () => {
  const patch = [
    "diff --git a/src/replay.ts b/src/replay.ts",
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/src/replay.ts",
    "+++ b/src/replay.ts",
    "@@ -10,4 +10,5 @@ export function replay()",
    " const start = 0;",
    "-const end = 1;",
    "+const end = 2;",
    "+const cap = 200;",
    " return frames;",
  ].join("\n");

  test("keeps every line, numbers them from the hunk and counts the changes", () => {
    const diff = readDiffText(patch);
    expect(diff.lines.map((line) => line.text).join("\n")).toBe(patch);
    expect(diff.files).toEqual(["src/replay.ts"]);
    expect({ additions: diff.additions, deletions: diff.deletions }).toEqual({
      additions: 2,
      deletions: 1,
    });
    expect(diff.numbered).toBe(true);
    expect(diff.lines.map((line) => [line.kind, line.old, line.new])).toEqual([
      ["meta", undefined, undefined],
      ["meta", undefined, undefined],
      ["meta", undefined, undefined],
      ["meta", undefined, undefined],
      ["hunk", undefined, undefined],
      ["context", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["add", undefined, 12],
      ["context", 12, 13],
    ]);
  });

  test("without headers it still reads as changes, unnumbered", () => {
    const diff = readDiffText("-old line\n+new line\n unchanged");
    expect(diff.lines.map((line) => line.kind)).toEqual(["del", "add", "context"]);
    expect(diff.numbered).toBe(false);
    expect(diff.files).toEqual([]);
  });

  test("a removed line starting with dashes is a change, with or without a hunk header", () => {
    expect(readDiffText("--- a comment\n kept").lines.map((line) => line.kind)).toEqual([
      "del",
      "context",
    ]);
    const inHunk = readDiffText("@@ -1,2 +1,1 @@\n--- a comment\n kept");
    expect(inHunk.lines.map((line) => line.kind)).toEqual(["hunk", "del", "context"]);
    expect(inHunk.deletions).toBe(1);
  });

  test("a diff of several files names each, and a deleted file by its old path", () => {
    const diff = readDiffText(
      [
        "--- a/one.ts",
        "+++ b/one.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-c",
      ].join("\n"),
    );
    expect(diff.files).toEqual(["one.ts", "gone.ts"]);
    expect(diff.lines.filter((line) => line.kind === "meta")).toHaveLength(4);
    expect({ additions: diff.additions, deletions: diff.deletions }).toEqual({
      additions: 1,
      deletions: 2,
    });
  });
});
