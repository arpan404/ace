import { expect, test } from "vitest";
import { diffList, withLeaving } from "./motion.ts";

test("a settled row leaves from where it was and the rest only close the gap", () => {
  const change = diffList(["a", "b", "c", "d"], ["a", "c", "d"]);
  expect(change.left).toEqual([{ key: "b", index: 1 }]);
  expect(change.entered).toEqual([]);
  expect(change.reordered).toBe(false);
  expect(withLeaving(["a", "c", "d"], change.left)).toEqual(["a", "b", "c", "d"]);
});

test("a new thread enters while the rows it pushes down keep their order", () => {
  const change = diffList(["a", "b"], ["n", "a", "b"]);
  expect(change.entered).toEqual(["n"]);
  expect(change.reordered).toBe(false);
});

test("a thread that starts needing you moves up: a reorder, nothing enters or leaves", () => {
  const change = diffList(["a", "b", "c"], ["c", "a", "b"]);
  expect(change).toMatchObject({ entered: [], left: [], reordered: true, bulk: false });
});

test("undoing a settle while the row is still fading out draws it once, as a present row", () => {
  expect(withLeaving(["a", "b", "c"], [{ key: "b", index: 1 }])).toEqual(["a", "b", "c"]);
});

test("rows leaving from the end of a shorter list stay at the end", () => {
  const change = diffList(["a", "b", "c", "d"], ["a"]);
  expect(withLeaving(["a"], change.left)).toEqual(["a", "b", "c", "d"]);
});

test("switching the project filter swaps many rows at once and reads as a reset", () => {
  const before = Array.from({ length: 10 }, (_, i) => `relay-${i}`);
  const after = Array.from({ length: 6 }, (_, i) => `ace-${i}`);
  expect(diffList(before, after).bulk).toBe(true);
});
