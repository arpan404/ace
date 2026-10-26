import { expect, test } from "vitest";
import { remainingWaitSeconds } from "./wait-deadline.ts";

test("a delegation's wait counts the time spent creating its children", () => {
  // Cursor allows 50 seconds; creating the children took 15 of them.
  expect(remainingWaitSeconds(50, 1_000, 16_000)).toBe(35);
  expect(remainingWaitSeconds(50, 1_000, 16_400)).toBe(34);
});

test("a delegation that used up its wait still reports its children after one second", () => {
  expect(remainingWaitSeconds(50, 0, 70_000)).toBe(1);
});

test("a delegation created instantly waits the full time it asked for", () => {
  expect(remainingWaitSeconds(240, 5_000, 5_000)).toBe(240);
});
