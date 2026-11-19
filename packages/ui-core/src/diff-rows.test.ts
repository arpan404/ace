import { expect, test } from "vitest";
import { parseUnifiedDiff, type DiffRow } from "./diff.ts";
import { fillFolds, hideWhitespace } from "./diff-rows.ts";

const file = (count: number, edit: (line: number) => string | undefined = () => undefined) =>
  `${Array.from({ length: count }, (_, i) => edit(i + 1) ?? `line ${i + 1}`).join("\n")}\n`;
const texts = (rows: readonly DiffRow[]) =>
  rows.map((row) => (row.kind === "fold" ? `fold:${row.lines?.length ?? "?"}` : row.text));

test("a fold between two hunks opens on the unchanged lines between them", () => {
  // 30 lines; line 2 and line 25 changed.
  const patch =
    "@@ -1,3 +1,3 @@\n line 1\n-old 2\n+line 2\n line 3\n@@ -24,3 +24,3 @@\n line 24\n-old 25\n+line 25\n line 26";
  const rows = fillFolds(parseUnifiedDiff(patch), file(30));
  const fold = rows[4];
  expect(fold?.kind).toBe("fold");
  const lines = fold?.kind === "fold" ? fold.lines : undefined;
  expect(lines?.map((line) => line.text)).toEqual(
    Array.from({ length: 20 }, (_, i) => `line ${i + 4}`),
  );
  expect(lines?.[0]).toMatchObject({ old: 4, new: 4 });
  // The lines after the last hunk become one more fold, at the end.
  expect(texts(rows).at(-1)).toBe("fold:4");
  // Every row of the patch keeps its place, so a fold's index still names it.
  expect(texts(rows).slice(0, 9)).toEqual([
    "line 1",
    "old 2",
    "line 2",
    "line 3",
    "fold:20",
    "line 24",
    "old 25",
    "line 25",
    "line 26",
  ]);
});

test("a fold before the first hunk numbers its lines from the top of the file", () => {
  const patch = "@@ -10,2 +12,3 @@\n line 10\n+added a\n+added b\n line 11";
  const after = file(14, (line) => (line === 11 ? "added a" : line === 12 ? "added b" : undefined));
  const rows = fillFolds(parseUnifiedDiff(patch), after);
  const fold = rows[0];
  expect(fold?.kind === "fold" && fold.lines?.length).toBe(9);
  expect(fold?.kind === "fold" && fold.lines?.[8]).toMatchObject({ old: 9, new: 9 });
});

test("a fold the text can't fill stays closed", () => {
  const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -40,1 +40,1 @@\n-c\n+d";
  const rows = fillFolds(parseUnifiedDiff(patch), "b\nshort\n");
  const fold = rows.find((row) => row.kind === "fold");
  expect(fold?.kind === "fold" && fold.lines).toBeUndefined();
});

test("a change that only re-indents reads as unchanged once whitespace is hidden", () => {
  const rows = parseUnifiedDiff(
    "@@ -1,3 +1,3 @@\n-if (a) {\n-  go();\n+if (a) {\n+    go();\n+    stop();\n }",
  );
  const shown = hideWhitespace(rows);
  expect(shown.map((row) => (row.kind === "fold" ? "fold" : `${row.kind} ${row.text}`))).toEqual([
    "context if (a) {",
    "context     go();",
    "add     stop();",
    "context }",
  ]);
  expect(shown[1]).toMatchObject({ old: 2, new: 2 });
});

test("a change of words stays a change with whitespace hidden", () => {
  const rows = parseUnifiedDiff("@@ -1 +1 @@\n-let a = 1;\n+let  b = 1;");
  expect(hideWhitespace(rows).map((row) => row.kind)).toEqual(["del", "add"]);
});
