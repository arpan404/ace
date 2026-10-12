import { defaultLimits } from "@ace/client";
import { expect, it } from "vitest";
import { recentFrom } from "./rows.ts";

it("a full live window folds its older turns, keeping the five newest whole", () => {
  // The store never holds more than its window: the fold must be reachable inside it.
  expect(recentFrom(40, 8, defaultLimits.items)).toBe(36);
  expect(recentFrom(40, 13, 20)).toBe(36);
});

it("a short window shows every turn whole", () => {
  expect(recentFrom(8, 8, 60)).toBe(Number.NEGATIVE_INFINITY);
  expect(recentFrom(undefined, 0, 0)).toBe(Number.NEGATIVE_INFINITY);
});
