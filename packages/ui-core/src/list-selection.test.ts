import { expect, test } from "vitest";
import { listedSelection, noSelection, selectRange, toggleSelected } from "./list-selection.ts";

const order = ["a", "b", "c", "d", "e"];

test("⌘-click picks threads one by one and a second ⌘-click puts one back", () => {
  let selection = toggleSelected(noSelection, "b");
  selection = toggleSelected(selection, "d");
  expect(selection.ids).toEqual(["b", "d"]);
  selection = toggleSelected(selection, "b");
  expect(selection.ids).toEqual(["d"]);
});

test("Shift-click takes everything between the last thread picked and this one, either way", () => {
  const picked = toggleSelected(noSelection, "b");
  expect(selectRange(picked, order, "d").ids).toEqual(["b", "c", "d"]);
  expect(selectRange(picked, order, "a").ids).toEqual(["a", "b"]);
  // A second Shift-click replaces the first range rather than adding to it.
  expect(selectRange(selectRange(picked, order, "e"), order, "c").ids).toEqual(["b", "c"]);
});

test("Shift-click with nothing picked yet picks just that thread", () => {
  expect(selectRange(noSelection, order, "c").ids).toEqual(["c"]);
});

test("a picked thread that leaves the list leaves the selection", () => {
  const selection = selectRange(toggleSelected(noSelection, "a"), order, "c");
  const after = listedSelection(selection, ["b", "c", "d"]);
  expect(after.ids).toEqual(["b", "c"]);
  expect(after.anchor).toBeUndefined();
  expect(listedSelection(after, ["b", "c", "d"])).toBe(after);
});
