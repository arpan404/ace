import { expect, test } from "vitest";
import { mapAnchor, type ViewAnchor } from "./use-anchor.ts";

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
