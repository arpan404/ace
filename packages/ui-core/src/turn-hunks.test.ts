import { expect, test } from "vitest";
import { revertChange } from "./change-hunks.ts";
import { linesOf } from "./live-hunks.ts";
import { keepAt, locateHunk, turnHunks } from "./turn-hunks.ts";
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

test("a hunk whose lines appear in two places is found in neither: no guess between copies", () => {
  const [first] = turnHunks(rowsOf(before, after));
  const twice = linesOf(`${after}one\nTWO\nthree\n`);
  expect(first && locateHunk(first, (line) => twice[line] ?? "", twice.length)).toBeUndefined();
});

test("Keep acts on a hunk only where it was shown: a move under it keeps nothing", () => {
  const [first] = turnHunks(rowsOf(before, after));
  if (!first) throw new Error("no hunk");
  const same = linesOf(after);
  const shown = locateHunk(first, (line) => same[line] ?? "", same.length);
  if (!shown) throw new Error("not found");
  expect(keepAt(first, shown, (line) => same[line] ?? "", same.length)).toEqual(shown);
  // A line typed above it since it was shown: it is elsewhere now, so this Keep keeps nothing.
  const moved = linesOf(`x\n${after}`);
  expect(keepAt(first, shown, (line) => moved[line] ?? "", moved.length)).toBeUndefined();
});
