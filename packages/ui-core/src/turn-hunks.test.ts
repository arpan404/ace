import { expect, test } from "vitest";
import { revertChange } from "./change-hunks.ts";
import { linesOf } from "./live-hunks.ts";
import { locateHunk, turnHunks } from "./turn-hunks.ts";
import { diffFile } from "./turns.ts";

/** The turn's diff of one file, as Changes builds it from a full-text edit. */
const rowsOf = (oldText: string, newText: string) =>
  diffFile({ path: "a.ts", changes: [{ kind: "update", path: "a.ts", oldText, newText }] }).rows;

const before = "one\ntwo\nthree\nfour\nfive\nsix\n";
const after = "one\nTWO\nthree\nfour\nsix\nseven\n";

test("a turn's hunks keep the lines around them", () => {
  const hunks = turnHunks(rowsOf(before, after));
  expect(
    hunks.map((hunk) => [hunk.start, hunk.added, hunk.removed, hunk.above, hunk.below]),
  ).toEqual([
    [2, ["TWO"], ["two"], "one", "three"],
    [5, [], ["five"], "four", "six"],
    [6, ["seven"], [], "six", undefined],
  ]);
});

test("each hunk is found where it is now, after lines were added above it", () => {
  const now = linesOf(`zero\nzero b\n${after}`);
  const lineAt = (line: number) => now[line] ?? "";
  const found = turnHunks(rowsOf(before, after)).map((hunk) =>
    locateHunk(hunk, lineAt, now.length),
  );
  expect(found.map((hunk) => hunk?.start)).toEqual([4, 7, 8]);
  // Found where it is, it reverts there.
  const first = found[0];
  expect(first && revertChange(first, lineAt, now.length)).toEqual({
    start: 3,
    end: 4,
    text: "two\n",
  });
});

test("a hunk edited since the turn is not found", () => {
  const now = linesOf(after.replace("TWO", "Two, edited"));
  const lineAt = (line: number) => now[line] ?? "";
  const [first] = turnHunks(rowsOf(before, after));
  expect(first && locateHunk(first, lineAt, now.length)).toBeUndefined();
});

test("a removal is found by the lines around its gap, and reverts there", () => {
  const before2 = "one\ntwo\nthree\nfour\n";
  const after2 = "one\ntwo\nfour\n";
  const [gap] = turnHunks(rowsOf(before2, after2));
  // Lines were added above since the turn.
  const now = linesOf(`new\n${after2}`);
  const lineAt = (line: number) => now[line] ?? "";
  const found = gap && locateHunk(gap, lineAt, now.length);
  expect(found && revertChange(found, lineAt, now.length)).toEqual({
    start: 3,
    end: 3,
    text: "three\n",
  });
});

test("a removal whose surrounding lines changed is not reverted", () => {
  const [gap] = turnHunks(rowsOf("one\ntwo\nthree\nfour\n", "one\ntwo\nfour\n"));
  const now = ["one", "two, edited", "four"];
  const lineAt = (line: number) => now[line] ?? "";
  // Where the turn left it, its anchors no longer match.
  expect(gap && revertChange(gap, lineAt, now.length)).toBeUndefined();
});

test("a reverted turn hunk keeps the file's CRLF endings", () => {
  const [hunk] = turnHunks(rowsOf("one\ntwo\nthree\n", "one\nTWO\nthree\n"));
  const now = ["one", "TWO", "three", ""];
  const lineAt = (line: number) => now[line] ?? "";
  expect(hunk && revertChange(hunk, lineAt, now.length, "\r\n")).toMatchObject({
    text: "two\r\n",
  });
});

test("a reverted turn hunk on a last line with no newline adds none", () => {
  const [hunk] = turnHunks(rowsOf("one\ntwo", "one\nTWO"));
  const now = ["one", "TWO"];
  const lineAt = (line: number) => now[line] ?? "";
  expect(hunk && revertChange(hunk, lineAt, now.length)).toEqual({
    start: 1,
    end: 2,
    text: "two",
  });
});
