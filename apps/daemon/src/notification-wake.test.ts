import { expect, test } from "vitest";
import { wakeDelay } from "./notification-wake.ts";

test("delivery wakes exactly at the next deadline and sets no timer without one", () => {
  expect(wakeDelay(10_500, 10_000, undefined)).toBe(500);
  expect(wakeDelay(null, 10_000, 9_000)).toBeUndefined();
});

test("newly due work runs at once, but work still held up after a run waits a second", () => {
  // Due after the last run began: new work, run now.
  expect(wakeDelay(9_500, 10_000, 9_000)).toBe(0);
  // Already due when the last run began and still due: a full queue, so no tight loop.
  expect(wakeDelay(8_000, 10_000, 9_000)).toBe(1000);
});
