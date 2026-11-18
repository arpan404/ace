import { expect, test } from "vitest";
import { lineHeight } from "./geometry.ts";
import { ScrollAnchor, mapAnchor, type ViewAnchor } from "./use-anchor.ts";
import type { RowLayout } from "./wrap-index.ts";
import type { WrapRow } from "./wrap.ts";

/*
 * The view anchor as a text position: an edit's spans move it by their net line change, a
 * position inside a changed region follows that region's first new line, and the fractional
 * offset into the row is kept whatever happens above it.
 */

const anchor = (line: number, column = 0, pixels = 0): ViewAnchor => ({ line, column, pixels });

test("a line inserted above the view takes the anchor with it, and removing it puts it back", () => {
  const entered = [{ firstLine: 0, removedLines: 1, insertedLines: 2 }];
  expect(mapAnchor(anchor(50, 3, 7), entered)).toEqual(anchor(51, 3, 7));

  const undone = [{ firstLine: 0, removedLines: 2, insertedLines: 1 }];
  expect(mapAnchor(anchor(51, 3, 7), undone)).toEqual(anchor(50, 3, 7));
});

test("an edit below the view leaves the anchor alone", () => {
  expect(
    mapAnchor(anchor(10, 0, 4), [{ firstLine: 40, removedLines: 3, insertedLines: 9 }]),
  ).toEqual(anchor(10, 0, 4));
});

test("two spans move the anchor by the change of the ones above it only", () => {
  const spans = [
    { firstLine: 2, removedLines: 1, insertedLines: 3 },
    { firstLine: 20, removedLines: 4, insertedLines: 1 },
  ];
  // The anchor at old line 30 sits below both; the first adds two lines, the second removes three.
  expect(mapAnchor(anchor(30), spans)).toEqual(anchor(29));
  // An anchor between them only sees the first.
  expect(mapAnchor(anchor(10), spans)).toEqual(anchor(12));
});

test("an anchor inside a changed region follows the region's first new line", () => {
  const spans = [{ firstLine: 5, removedLines: 10, insertedLines: 2 }];
  expect(mapAnchor(anchor(8), spans)).toEqual(anchor(6));
  // Past the last new line of the region, it stays on the region's last line.
  expect(mapAnchor(anchor(14), spans)).toEqual(anchor(6));
});

test("the anchor never falls before the document", () => {
  expect(mapAnchor(anchor(0), [{ firstLine: 0, removedLines: 4, insertedLines: 1 }])).toEqual({
    line: 0,
    column: 0,
    pixels: 0,
  });
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
