import { expect, test } from "vitest";
import { clampToBounds, panelBounds, panelFloats } from "./bounds.ts";

test("beside the column the side panel keeps the column at least 480px wide", () => {
  expect(panelBounds(1076, false)).toEqual({ min: 360, max: 596 });
  // Too little room: the panel never drops below its minimum.
  expect(panelBounds(700, false)).toEqual({ min: 360, max: 360 });
});

test("floating over a narrow window the side panel leaves a 48px strip of the column", () => {
  expect(panelBounds(1024, true)).toEqual({ min: 360, max: 976 });
  expect(panelBounds(300, true)).toEqual({ min: 252, max: 252 });
});

test("a remembered size outside the room left is drawn within it", () => {
  expect(clampToBounds(900, { min: 360, max: 596 })).toBe(596);
  expect(clampToBounds(100.4, { min: 360, max: 610 })).toBe(360);
});

test("floating policy uses available room while predicting the crowded sidebar yield", () => {
  expect(panelFloats(821, false, false)).toBe(true);
  expect(panelFloats(840, false, false)).toBe(false);
  expect(panelFloats(720, false, true)).toBe(false);
  expect(panelFloats(1000, true, true)).toBe(true);
});
