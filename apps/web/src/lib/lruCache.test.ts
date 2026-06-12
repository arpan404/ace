import { describe, expect, it } from "vitest";
import { LRUCache } from "./lruCache";

describe("LRUCache", () => {
  it("returns null for missing keys", () => {
    const cache = new LRUCache<string>(2, 100);
    expect(cache.get("missing")).toBeNull();
  });

  it("evicts oldest by max entries", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("promotes on get and evicts least recently used", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    expect(cache.get("a")).toBe("A");

    cache.set("c", "C", 10);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("C");
  });

  it("peeks without promoting entries", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    expect(cache.peek("a")).toBe("A");

    cache.set("c", "C", 10);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("evicts by memory budget", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("evicts unprotected entries before protected visible entries", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("tail", "TAIL", 10);
    cache.set("older", "OLDER", 10);
    cache.set("newer", "NEWER", 10, new Set(["tail"]));

    expect(cache.get("tail")).toBe("TAIL");
    expect(cache.get("older")).toBeNull();
    expect(cache.get("newer")).toBe("NEWER");
  });
});
