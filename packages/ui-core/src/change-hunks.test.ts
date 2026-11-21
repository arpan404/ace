import { expect, test } from "vitest";
import { changeHunks, hunkAt, revertChange } from "./change-hunks.ts";
import { gitPatchFiles } from "./git-patch.ts";
import { lineMarks } from "./line-marks.ts";

/** A file's rows from a one-file git patch, as the editor's gutter reads them. */
function rowsOf(...hunk: string[]) {
  const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...hunk, ""].join("\n");
  return gitPatchFiles(patch)[0]?.rows ?? [];
}

const current = ["one", "TWO", "three", "four", "added", "six"];
const lineAt = (line: number) => current[line] ?? "";
/** The same text with line 2 typed over since the diff was read. */
const edited = (line: number) => (line === 1 ? "Two" : lineAt(line));
const rows = rowsOf(
  "@@ -1,7 +1,6 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "-gone",
  " four",
  "+added",
  " six",
  "-last",
);

test("each run of changed lines is one hunk: what the file has now and what it replaced", () => {
  expect(changeHunks(rows)).toEqual([
    { start: 2, marks: [2], added: ["TWO"], removed: ["two"] },
    { start: 4, marks: [4], added: [], removed: ["gone"] },
    { start: 5, marks: [5], added: ["added"], removed: [] },
    { start: 7, marks: [6], added: [], removed: ["last"] },
  ]);
});

test("every gutter mark leads to the hunk it marks", () => {
  const hunks = changeHunks(rows);
  for (const line of lineMarks(rows).keys()) expect(hunkAt(hunks, line)).toBeDefined();
  expect(hunkAt(hunks, 4)?.removed).toEqual(["gone"]);
  expect(hunkAt(hunks, 6)?.removed).toEqual(["last"]);
  expect(hunkAt(hunks, 1)).toBeUndefined();
});

test("reverting a hunk swaps its lines for the committed ones", () => {
  const [modified, removal, addition] = changeHunks(rows);
  expect(modified && revertChange(modified, lineAt, current.length)).toEqual({
    start: 1,
    end: 2,
    text: "two\n",
  });
  expect(removal && revertChange(removal, lineAt, current.length)).toEqual({
    start: 3,
    end: 3,
    text: "gone\n",
  });
  expect(addition && revertChange(addition, lineAt, current.length)).toEqual({
    start: 4,
    end: 5,
    text: "",
  });
});

test("a hunk whose lines no longer match the text is not reverted", () => {
  const [modified] = changeHunks(rows);
  expect(modified && revertChange(modified, edited, current.length)).toBeUndefined();
});
