import type { LineEdit } from "@ace/editor";
import { expect, test } from "vitest";
import { FoldSet } from "./fold-set.ts";
import { hiddenRanges, type FoldRange } from "./folding.ts";

/* The editor's closed folds through edits: moved, kept or opened, in work near the edit. */

/** Nested regions as Fold All finds them: `count` blocks of a header, two children and a close. */
function nestedFolds(count: number): FoldRange[] {
  const folds: FoldRange[] = [];
  for (let block = 0; block < count; block++) {
    const top = block * 8;
    folds.push({ start: top, end: top + 6 }, { start: top + 1, end: top + 2 });
    folds.push({ start: top + 4, end: top + 5 });
  }
  return folds.toSorted((a, b) => a.start - b.start);
}

const moved = (folds: readonly FoldRange[], spans: LineEdit[]) => {
  const set = FoldSet.of(folds);
  set.map(spans);
  return set.toArray();
};

test("folds move with edits above them and open when their hidden text changes", () => {
  const folds = [{ start: 4, end: 6 }];
  // Two lines inserted on line 1: the fold moves down by two.
  expect(moved(folds, [{ firstLine: 1, removedLines: 1, insertedLines: 3 }])).toEqual([
    { start: 6, end: 8 },
  ]);
  // Typing on the header line keeps it; Enter there changes its line count and opens it.
  expect(moved(folds, [{ firstLine: 4, removedLines: 1, insertedLines: 1 }])).toEqual(folds);
  expect(moved(folds, [{ firstLine: 4, removedLines: 1, insertedLines: 2 }])).toEqual([]);
  // An edit inside opens it.
  expect(moved(folds, [{ firstLine: 5, removedLines: 1, insertedLines: 1 }])).toEqual([]);
  // An edit below leaves it.
  expect(moved(folds, [{ firstLine: 9, removedLines: 1, insertedLines: 4 }])).toEqual(folds);
});

test("several edits at once (multi-cursor) each move the folds below them", () => {
  const folds = [
    { start: 2, end: 3 },
    { start: 6, end: 8 },
    { start: 12, end: 13 },
  ];
  // A line added at 0 and, in the new text, a line removed at 10 (two lines joined).
  expect(
    moved(folds, [
      { firstLine: 10, removedLines: 2, insertedLines: 1 },
      { firstLine: 0, removedLines: 1, insertedLines: 2 },
    ]),
  ).toEqual([
    { start: 3, end: 4 },
    { start: 7, end: 9 },
    { start: 12, end: 13 },
  ]);
});

test("after Fold All, edits around the file keep every fold they don't touch", () => {
  const set = FoldSet.of(nestedFolds(40));
  // Typing on each block's header line, top to bottom and back: nothing opens or moves.
  for (let block = 0; block < 40; block++)
    set.map([{ firstLine: block * 8, removedLines: 1, insertedLines: 1 }]);
  for (let block = 39; block >= 0; block--)
    set.map([{ firstLine: block * 8, removedLines: 1, insertedLines: 1 }]);
  expect(set.toArray()).toEqual(nestedFolds(40));
  // A line added after the first block's closer moves the 39 blocks below it, and only them.
  set.map([{ firstLine: 7, removedLines: 1, insertedLines: 2 }]);
  expect(set.toArray()).toEqual([
    ...nestedFolds(1),
    ...nestedFolds(40)
      .slice(3)
      .map((fold) => ({ start: fold.start + 1, end: fold.end + 1 })),
  ]);
  // An edit inside block 10's first child opens it and block 10's outer fold, nothing else.
  set.map([{ firstLine: 10 * 8 + 1 + 2, removedLines: 1, insertedLines: 1 }]);
  expect(set.size).toBe(40 * 3 - 2);
  expect(set.has(10 * 8 + 1)).toBe(false);
  expect(set.has(10 * 8 + 1 + 1)).toBe(false);
  expect(set.has(10 * 8 + 1 + 4)).toBe(true);
  expect(set.has(11 * 8 + 1)).toBe(true);
});

test("an edit that opens a fold shows only that fold's lines; nested folds stay closed", () => {
  // 0 header { 1 a { 2 hidden } 3 } 4 b { 5 hidden } 6 }
  const set = FoldSet.of([
    { start: 0, end: 6 },
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ]);
  // A line typed into line 3 (hidden by the outer fold only): the outer fold opens.
  const shown = set.map([{ firstLine: 3, removedLines: 1, insertedLines: 2 }]);
  expect(set.toArray()).toEqual([
    { start: 1, end: 2 },
    { start: 5, end: 6 },
  ]);
  // Lines 1, 3 (now the edited 3 and 4), 4 and 6 (now 5 and 7) show; 2 and 5 (now 6) stay
  // under their own folds.
  expect(shown).toEqual([
    { from: 1, to: 2 },
    { from: 3, to: 5 },
    { from: 5, to: 6 },
    { from: 7, to: 8 },
  ]);
  expect(hiddenRanges(set.toArray())).toEqual([
    { from: 2, to: 3 },
    { from: 6, to: 7 },
  ]);
});

test("typing in one place among many folds touches the folds near it, not every fold", () => {
  const folds = nestedFolds(100_000);
  const work = { entries: 0 };
  const set = FoldSet.of(folds, work);
  let most = 0;
  const edit = (span: LineEdit) => {
    work.entries = 0;
    set.map([span]);
    most = Math.max(most, work.entries);
  };
  // Typing on a visible line in the middle: a header line of a closed fold.
  const header = 400_000;
  for (let key = 0; key < 5_000; key++) {
    edit({ firstLine: header, removedLines: 1, insertedLines: 1 });
    expect(set.has(header)).toBe(true);
  }
  // Enter after a closing line in the middle, a few times: every fold below moves.
  for (let key = 0; key < 200; key++)
    edit({ firstLine: header + 7, removedLines: 1, insertedLines: 2 });
  // A few binary searches' worth per edit; work over every fold would be 300,000.
  expect(most).toBeLessThan(500);
  expect(set.has(header + 8 + 200)).toBe(true);
  expect(set.size).toBe(folds.length);
});
