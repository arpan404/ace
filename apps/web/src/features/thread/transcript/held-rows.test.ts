import { expect, test } from "vitest";
import { rowsAround, withHeldRows } from "./held-rows.ts";

/** Rows of the given heights, stacked from 0. */
function stacked(heights: readonly number[]) {
  let start = 0;
  return heights.map((height) => {
    const row = { start, end: start + height };
    start += height;
    return row;
  });
}

test("the rows drawn for a held row are the ones the view will show once it follows that row", () => {
  // Ten 100px rows; row 6 starts 40px above a 250px view: the view spans 640 to 890.
  const rows = stacked(Array.from({ length: 10 }, () => 100));
  expect(rowsAround(rows, 6, -40, 250, 0)).toEqual([6, 7, 8]);
  expect(rowsAround(rows, 6, -40, 250, 2)).toEqual([4, 5, 6, 7, 8, 9]);
});

test("a held row pushed far down by rows landing above is drawn where it now is", () => {
  // Rows landed above: the held row is now row 40, still 10px below the view's top, so the
  // view shows the last 10px of row 39 and 390px of row 40.
  const rows = stacked([...Array.from({ length: 40 }, () => 96), 500, 80, 80]);
  expect(rowsAround(rows, 40, 10, 400, 0)).toEqual([39, 40]);
  expect(rowsAround(rows, 40, 10, 400, 1)).toEqual([38, 39, 40, 41]);
});

test("the virtualizer's rows are kept, and the held row's added only where they are missing", () => {
  expect(withHeldRows([3, 4, 5], [4, 5])).toEqual([3, 4, 5]);
  expect(withHeldRows([0, 1, 2], [40, 41])).toEqual([0, 1, 2, 40, 41]);
  expect(withHeldRows([0, 1, 2], [])).toEqual([0, 1, 2]);
});
