import { expect, test } from "vitest";
import { retention } from "./idb-cache.ts";

/** Sizes, most recently used first, and which of them the cache keeps. */
const kept = (sizes: number[], limits: { maxEntries: number; maxBytes: number }) => {
  const keep = retention(limits);
  return sizes.map((size) => keep(size));
};

test("a few huge entries push out older ones even under the entry cap", () => {
  expect(kept([400, 400, 400, 10], { maxEntries: 100, maxBytes: 1_000 })).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

test("many small entries are capped by count, least recently used pruned first", () => {
  expect(kept([1, 1, 1, 1], { maxEntries: 3, maxBytes: 1_000 })).toEqual([true, true, true, false]);
});
