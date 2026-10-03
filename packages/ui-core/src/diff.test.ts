import { expect, test } from "vitest";
import { diffTexts, fold, pairRows, parseUnifiedDiff, type DiffRow } from "./diff.ts";
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
