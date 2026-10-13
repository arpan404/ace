import { expect, it } from "vitest";
import { recentFrom } from "./rows.ts";

it("past twelve turns, the older ones fold and the five newest stay whole", () => {
  expect(recentFrom(40, 13)).toBe(36);
});

it("a thread of twelve turns or fewer shows every turn whole, however many items it holds", () => {
  expect(recentFrom(8, 8)).toBe(Number.NEGATIVE_INFINITY);
  expect(recentFrom(12, 12)).toBe(Number.NEGATIVE_INFINITY);
  expect(recentFrom(undefined, 0)).toBe(Number.NEGATIVE_INFINITY);
});
