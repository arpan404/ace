import { expect, test } from "vitest";
import { contentHash } from "./content-hash.ts";
import { LruCache } from "./lru.ts";

test("the least recently used entry goes first when the cache is full", () => {
  const cache = new LruCache<string, number>({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
});

test("total weight stays under its budget however many entries arrive", () => {
  const cache = new LruCache<number, string>({
    maxEntries: 1_000,
    maxWeight: 100,
    weigh: (text) => text.length,
  });
  for (let n = 0; n < 500; n++) cache.set(n, "x".repeat(30));
  expect(cache.weight).toBeLessThanOrEqual(100);
  expect(cache.size).toBe(3);
  expect(cache.get(499)).toBeDefined();
  cache.set(-1, "y".repeat(101));
  expect(cache.get(-1)).toBeUndefined();
});

test("replacing an entry counts its weight once", () => {
  const cache = new LruCache<string, string>({ maxEntries: 5, weigh: (text) => text.length });
  cache.set("k", "abc");
  cache.set("k", "abcdef");
  expect(cache.weight).toBe(6);
});

test("content hashes differ for texts that differ, and match for equal texts", () => {
  const texts = ["", "a", "b", "ab", "ba", "hello world", "hello worle", "x".repeat(10_000)];
  const hashes = new Set(texts.map(contentHash));
  expect(hashes.size).toBe(texts.length);
  expect(contentHash("hello world")).toBe(contentHash(`hello ${"world"}`));
});
