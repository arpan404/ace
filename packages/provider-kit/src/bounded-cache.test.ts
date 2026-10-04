import { expect, test } from "vitest";
import { BoundedCache } from "./bounded-cache.ts";

test("a recently read entry survives count pressure while the oldest entry is evicted", () => {
  const cache = new BoundedCache<string, string>(2, 100);
  cache.set("a", "first", 5);
  cache.set("b", "second", 6);
  expect(cache.get("a")).toBe("first");
  cache.set("c", "third", 5);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe("first");
  expect(cache.get("c")).toBe("third");
});
test("replacement releases its old byte reservation and oversized values are not retained", () => {
  const cache = new BoundedCache<string, string>(10, 10);
  cache.set("a", "eight", 8);
  cache.set("a", "two", 2);
  cache.set("b", "eight", 8);
  expect(cache.get("a")).toBe("two");
  expect(cache.get("b")).toBe("eight");
  cache.set("c", "large", 11);
  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("b")).toBe("eight");
  cache.set("d", "three", 3);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("d")).toBe("three");
});
test("deletion and clearing release reservations for subsequent entries", () => {
  const cache = new BoundedCache<string, number>(2, 4);
  cache.set("a", 1, 4);
  cache.delete("a");
  cache.set("b", 2, 4);
  expect(cache.get("b")).toBe(2);
  cache.clear();
  cache.set("c", 3, 4);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("c")).toBe(3);
});
