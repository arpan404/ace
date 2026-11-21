import { expect, test } from "vitest";
import { changeHunks, revertChange } from "./change-hunks.ts";
import { gitPatchFiles } from "./git-patch.ts";
import { committedText, hunkMarks, hunksFromChanges, linesOf } from "./live-hunks.ts";

function rowsOf(...hunk: string[]) {
  const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...hunk, ""].join("\n");
  return gitPatchFiles(patch)[0]?.rows ?? [];
}

const committed = "one\ntwo\nthree\ngone\nfour\nsix\nlast\n";
const disk = "one\nTWO\nthree\nfour\nadded\nsix\n";
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

test("the committed text comes back from the file on disk and its git hunks", () => {
  expect(committedText(disk, changeHunks(rows))).toBe(committed);
});

test("a file with no hunks is its own committed text", () => {
  expect(committedText(disk, [])).toBe(disk);
});

test("hunks read for another version of the file give no committed text", () => {
  expect(committedText("one\nTwo typed\nthree\nfour\nadded\nsix\n", changeHunks(rows))).toBe(
    undefined,
  );
});

test("CRLF files keep their endings in the committed text", () => {
  const crlf = disk.replaceAll("\n", "\r\n");
  expect(committedText(crlf, changeHunks(rows))).toBe(committed.replaceAll("\n", "\r\n"));
});

const lines = linesOf("one\nTWO\nthree\nfour\nadded\nsix\nnew\n");
const lineAt = (line: number) => lines[line] ?? "";

test.each([
  {
    name: "a typed-over line is modified",
    change: { start: 1, end: 2, text: "two\n" },
    marks: [[2, "modified"]],
  },
  {
    name: "a new line is added",
    change: { start: 4, end: 5, text: "" },
    marks: [[5, "added"]],
  },
  {
    name: "a block longer than what it replaced is modified, then added",
    change: { start: 1, end: 4, text: "two\n" },
    marks: [
      [2, "modified"],
      [3, "added"],
      [4, "added"],
    ],
  },
  {
    name: "removed lines mark the line below them",
    change: { start: 3, end: 3, text: "gone\n" },
    marks: [[4, "removed"]],
  },
  {
    name: "lines removed at the end mark the last line",
    change: { start: 8, end: 8, text: "last\n" },
    marks: [[7, "removed"]],
  },
] as const)("$name", ({ change, marks }) => {
  expect([...hunkMarks(hunksFromChanges([change], lineAt, lines.length))]).toEqual(marks);
});

test("a live hunk reverts to the committed lines it replaced", () => {
  const [hunk] = hunksFromChanges([{ start: 1, end: 2, text: "two\n" }], lineAt, lines.length);
  expect(hunk && revertChange(hunk, lineAt, lines.length)).toEqual({
    start: 1,
    end: 2,
    text: "two\n",
  });
});
