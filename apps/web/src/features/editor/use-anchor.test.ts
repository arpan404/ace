import { expect, test } from "vitest";
import type { Position, TextReplacement } from "@ace/editor";
import { lineHeight } from "./geometry.ts";
import { ScrollAnchor, mapAnchor, type ViewAnchor } from "./use-anchor.ts";
import type { RowLayout } from "./wrap-index.ts";
import type { WrapRow } from "./wrap.ts";

/*
 * The view anchor as a text position: a transaction's replaced ranges move it by their line and
 * column change, a position inside a replaced range follows the end of its new text, and the
 * fractional offset into the row is kept whatever happens above it.
 */

const anchor = (line: number, column = 0, pixels = 0): ViewAnchor => ({ line, column, pixels });

const point = (line: number, column: number): Position => ({ line, column });

/** One replacement: old start, old end, and where its new text ends after the transaction. */
const replaced = (
  start: [number, number],
  end: [number, number],
  postEnd: [number, number],
): TextReplacement => ({
  start: point(...start),
  end: point(...end),
  postEnd: point(...postEnd),
});

test("a line inserted above the view takes the anchor with it, and removing it puts it back", () => {
  const entered = [replaced([0, 0], [0, 0], [1, 0])];
  expect(mapAnchor(anchor(50, 3, 7), entered)).toEqual(anchor(51, 3, 7));

  const undone = [replaced([0, 0], [1, 0], [0, 0])];
  expect(mapAnchor(anchor(51, 3, 7), undone)).toEqual(anchor(50, 3, 7));
});

test("an edit below the view leaves the anchor alone", () => {
  expect(mapAnchor(anchor(10, 0, 4), [replaced([40, 0], [43, 0], [49, 0])])).toEqual(
    anchor(10, 0, 4),
  );
});

test("two spans move the anchor by the change of the ones above it only", () => {
  const changes = [
    // Two lines inserted at line 2, ending at line 4 after the first change.
    replaced([2, 0], [2, 0], [4, 0]),
    // Four old lines at 20 replaced by one; its new text ends at line 23 once both changes land.
    replaced([20, 0], [24, 0], [23, 0]),
  ];
  // The anchor at old line 30 sits below both; the first adds two lines, the second removes three.
  expect(mapAnchor(anchor(30), changes)).toEqual(anchor(29));
  // An anchor between them only sees the first.
  expect(mapAnchor(anchor(10), changes)).toEqual(anchor(12));
});

test("an anchor inside a changed region follows the end of the region's new text", () => {
  const changes = [replaced([5, 0], [15, 0], [7, 0])];
  expect(mapAnchor(anchor(8), changes)).toEqual(anchor(7));
  // Past the last new line of the region, it still lands at the replacement's end.
  expect(mapAnchor(anchor(14), changes)).toEqual(anchor(7));
});

test("an edit inside the anchored line moves the anchor's column with its text", () => {
  // Two characters typed at the start of line 10: the text the reader watched shifts right.
  expect(mapAnchor(anchor(10, 4, 7), [replaced([10, 0], [10, 0], [10, 2])])).toEqual(
    anchor(10, 6, 7),
  );
  // Undoing it takes the column back.
  expect(mapAnchor(anchor(10, 6, 7), [replaced([10, 0], [10, 2], [10, 0])])).toEqual(
    anchor(10, 4, 7),
  );
});

test("a position inside the replaced text lands at the end of its new text", () => {
  expect(mapAnchor(anchor(10, 4), [replaced([10, 2], [10, 6], [10, 3])])).toEqual(anchor(10, 3));
});

test("two carets editing one line move the anchor by both changes", () => {
  // A one-line transaction can replace two ranges on the anchored line; the later one's post-end
  // already carries the earlier one's shift.
  const changes = [replaced([10, 0], [10, 0], [10, 2]), replaced([10, 5], [10, 5], [10, 8])];
  expect(mapAnchor(anchor(10, 7), changes)).toEqual(anchor(10, 10));
});

test("a position before every change stays where it is", () => {
  expect(mapAnchor(anchor(0, 0), [replaced([3, 0], [7, 0], [8, 0])])).toEqual(anchor(0, 0));
});

test("the anchor never falls before the document", () => {
  expect(mapAnchor(anchor(0, 0), [replaced([0, 0], [0, 0], [0, 0])])).toEqual(anchor(0, 0));
});

/** One line wrapped into fixed-width rows, so a row start is also the row before its end. */
function wrappingLayout(rows: readonly WrapRow[], lines: number): RowLayout {
  return {
    startOf: (line) => line * rows.length,
    lineAt: (row) => Math.min(lines - 1, Math.floor(row / rows.length)),
    rowsOf: () => rows,
    total: () => lines * rows.length,
  };
}

test("restoring a row start keeps that row at the top instead of the row before it", () => {
  // Every row starts where the row before it ends: exactly a hard break's two sides.
  const rows = Array.from({ length: 40 }, (_, at) => ({
    start: at * 10,
    end: (at + 1) * 10,
    indent: 0,
  }));
  const layout = wrappingLayout(rows, 1);
  const element = document.createElement("div");
  element.scrollTop = 10 * lineHeight;

  const scroll = new ScrollAnchor({ current: element }, () => undefined);
  scroll.remember(layout);
  scroll.restore(layout);

  // The eleventh row's start was remembered; the tenth row's end is the same column.
  expect(element.scrollTop).toBe(10 * lineHeight);
});

test("a remembered row start restored twice never walks the view back a row", () => {
  const rows = Array.from({ length: 40 }, (_, at) => ({
    start: at * 10,
    end: (at + 1) * 10,
    indent: 0,
  }));
  const layout = wrappingLayout(rows, 1);
  const element = document.createElement("div");
  element.scrollTop = 10 * lineHeight;

  const scroll = new ScrollAnchor({ current: element }, () => undefined);
  for (let slice = 0; slice < 5; slice++) {
    // One idle slice of a re-wrap remembers the top and puts it back, rows unchanged.
    scroll.remember(layout);
    scroll.restore(layout);
  }

  expect(element.scrollTop).toBe(10 * lineHeight);
});
