import { expect, test } from "vitest";
import { bottomBounds, clampToBounds, rightBounds } from "./bounds.ts";

test("beside the column the side panel keeps the column at least 480px wide", () => {
  expect(rightBounds(1076, false)).toEqual({ min: 360, max: 596 });
  // Too little room: the panel never drops below its minimum.
  expect(rightBounds(700, false)).toEqual({ min: 360, max: 360 });
});

test("floating over a narrow window the side panel leaves a 48px strip of the column", () => {
  expect(rightBounds(1024, true)).toEqual({ min: 360, max: 976 });
  expect(rightBounds(300, true)).toEqual({ min: 252, max: 252 });
});

test("the bottom panel leaves 240px of the screen above it", () => {
  expect(bottomBounds(850)).toEqual({ min: 160, max: 610 });
  expect(bottomBounds(300)).toEqual({ min: 160, max: 160 });
});

test("a remembered size outside the room left is drawn within it", () => {
  expect(clampToBounds(900, { min: 360, max: 596 })).toBe(596);
  expect(clampToBounds(100.4, { min: 160, max: 610 })).toBe(160);
});
