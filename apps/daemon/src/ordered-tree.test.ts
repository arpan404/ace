import { expect, test } from "vitest";
import { OrderedTree } from "./ordered-tree.ts";

/** Seeded generator, so a failing sequence replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const compare = (a: number, b: number) => a - b;

test("the tree reads back in order through random inserts, removes and reloads", () => {
  for (const seed of [1, 2, 3]) {
    const next = random(seed);
    const tree = new OrderedTree(compare);
    let expected: number[] = [];
    for (let step = 0; step < 4000; step++) {
      const roll = next();
      const value = Math.floor(next() * 500);
      if (roll < 0.002) {
        // Rebuild from sorted items, as the sidebar index does after a delete.
        expected = [...new Set(expected)].toSorted(compare);
        tree.load(expected);
      } else if (roll < 0.55) {
        tree.insert(value);
        if (!expected.includes(value)) expected = [...expected, value].toSorted(compare);
      } else {
        tree.remove(value);
        expected = expected.filter((item) => item !== value);
      }
      expect(tree.size, `seed ${seed}, step ${step}`).toBe(expected.length);
      const limit = Math.floor(next() * 8);
      expect(tree.first(limit), `seed ${seed}, step ${step}`).toEqual(expected.slice(0, limit));
    }
    expect(tree.first(Infinity)).toEqual(expected);
  }
});

test("items inserted in order stay cheap to update", () => {
  // Time-ordered inserts are the worst case for a sorted array; a balanced tree keeps
  // each update to a handful of comparisons.
  let comparisons = 0;
  const tree = new OrderedTree((a: number, b: number) => {
    comparisons++;
    return b - a;
  });
  for (let value = 0; value < 50_000; value++) tree.insert(value);
  comparisons = 0;
  tree.insert(50_000);
  tree.remove(25_000);
  // A tree this size is at most ~23 levels deep; a remove may walk down twice.
  expect(comparisons).toBeLessThan(3 * 24);
  expect(tree.first(3)).toEqual([50_000, 49_999, 49_998]);
});
