import { expect, test } from "vitest";
import { createMathCache, mathCache, renderMathCached, setMathRenderer } from "./math-cache.ts";

test("a rendered formula comes back from the cache", () => {
  const cache = createMathCache();
  expect(cache.get(false, "x+1")).toBeUndefined();
  cache.set(false, "x+1", "<span>one</span>");
  expect(cache.get(false, "x+1")).toBe("<span>one</span>");
});

test("inline and display formulas do not share entries", () => {
  const cache = createMathCache();
  cache.set(false, "x", "<span>inline</span>");
  expect(cache.get(true, "x")).toBeUndefined();
  cache.set(true, "x", "<span>display</span>");
  expect(cache.get(false, "x")).toBe("<span>inline</span>");
  expect(cache.get(true, "x")).toBe("<span>display</span>");
});

test("the oldest formulas go once the entry budget is spent", () => {
  const cache = createMathCache({ maxEntries: 2, maxBytes: 1024 * 1024 });
  cache.set(false, "a", "<span>a</span>");
  cache.set(false, "b", "<span>b</span>");
  expect(cache.get(false, "a")).toBe("<span>a</span>");
  // Reading `a` refreshes it, so `b` is the oldest when `c` arrives.
  cache.set(false, "c", "<span>c</span>");
  expect(cache.get(false, "b")).toBeUndefined();
  expect(cache.get(false, "a")).toBe("<span>a</span>");
  expect(cache.get(false, "c")).toBe("<span>c</span>");
});

test("heavy formulas go once the byte budget is spent", () => {
  const cache = createMathCache({ maxEntries: 1000, maxBytes: 30 });
  cache.set(false, "a", "<span>0123456789</span>");
  expect(cache.weight).toBeLessThanOrEqual(30);
  cache.set(false, "b", "<span>0123456789</span>");
  expect(cache.weight).toBeLessThanOrEqual(30);
  // Only the newest fits: the budget holds one entry, not both.
  expect(cache.get(false, "a")).toBeUndefined();
  expect(cache.get(false, "b")).toBe("<span>0123456789</span>");
});

test("a formula heavier than the whole budget is not kept", () => {
  const cache = createMathCache({ maxEntries: 1000, maxBytes: 4 });
  cache.set(false, "a", "<span>0123456789</span>");
  expect(cache.size).toBe(0);
  expect(cache.get(false, "a")).toBeUndefined();
});

test("unbounded formulas stay bounded", () => {
  const cache = createMathCache();
  for (let i = 0; i < 10_000; i++) cache.set(i % 2 === 0, `x_{${i}}`, `<span>${i}</span>`);
  expect(cache.size).toBeLessThanOrEqual(1000);
  expect(cache.weight).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("without a renderer nothing renders", () => {
  setMathRenderer(undefined);
  expect(renderMathCached("unseen-tex", false)).toBeUndefined();
});

test("a registered renderer fills the shared cache", () => {
  setMathRenderer((tex) => `<span>${tex}</span>`);
  try {
    expect(renderMathCached("shared-tex", false)).toBe("<span>shared-tex</span>");
    expect(mathCache.get(false, "shared-tex")).toBe("<span>shared-tex</span>");
  } finally {
    setMathRenderer(undefined);
  }
  // The cache answers after the renderer leaves.
  expect(renderMathCached("shared-tex", false)).toBe("<span>shared-tex</span>");
});

test("a throwing renderer never throws its caller", () => {
  setMathRenderer(() => {
    throw new Error("bad tex");
  });
  try {
    expect(renderMathCached("bad-tex", true)).toBeUndefined();
  } finally {
    setMathRenderer(undefined);
  }
});
