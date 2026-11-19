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

test("a value the cache drops on its own is freed; one taken out is not", () => {
  const freed: string[] = [];
  const cache = new LruCache<string, string>({
    maxEntries: 2,
    maxWeight: 100,
    weigh: (value) => value.length,
    dispose: (value) => freed.push(value),
  });
  cache.set("a", "a");
  cache.set("b", "b");
  cache.set("c", "c");
  expect(freed).toEqual(["a"]);
  expect(cache.take("b")).toBe("b");
  expect(cache.has("b")).toBe(false);
  cache.set("c", "c2");
  cache.set("huge", "x".repeat(101));
  expect(freed).toEqual(["a", "c", "x".repeat(101)]);
  cache.clear();
  expect(freed).toEqual(["a", "c", "x".repeat(101), "c2"]);
});
