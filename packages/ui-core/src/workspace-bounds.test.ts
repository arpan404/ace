import { expect, test } from "vitest";
import { bottomBounds, clampToBounds } from "./workspace-bounds.ts";

test("a remembered size outside the room left is drawn within it", () => {
  expect(clampToBounds(900, { min: 360, max: 596 })).toBe(596);
  expect(clampToBounds(100.4, { min: 360, max: 610 })).toBe(360);
});

test("the bottom panel leaves the conversation 240px of the screen's height, and never drops below 120px", () => {
  expect(bottomBounds(900)).toEqual({ min: 120, max: 660 });
  expect(bottomBounds(300)).toEqual({ min: 120, max: 120 });
});
