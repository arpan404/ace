import { expect, test } from "vitest";
import { limitPace, resetCountdown } from "./usage-limits.ts";

const now = Date.parse("2026-10-13T12:00:00Z");
const hour = 3_600_000;

test("a five-hour window half used one hour in is running out faster than it resets", () => {
  // 4 of 5 hours left: a fifth of the window has run.
  expect(limitPace(50, now + 4 * hour, 300, now)).toBe("ahead");
  expect(limitPace(20, now + 4 * hour, 300, now)).toBe("on_pace");
  expect(limitPace(5, now + hour, 300, now)).toBe("behind");
});

test("a window without a length or a reset time has no pace", () => {
  expect(limitPace(50, null, 300, now)).toBeUndefined();
  expect(limitPace(50, now + hour, undefined, now)).toBeUndefined();
});

test("reset countdowns read in minutes, hours and days, and say nothing when not reported", () => {
  expect(resetCountdown(now + 14 * 60_000, now)).toBe("14m");
  expect(resetCountdown(now + 4 * hour + 59 * 60_000, now)).toBe("4h 59m");
  expect(resetCountdown(now + 6 * 24 * hour + 12 * hour, now)).toBe("6d 12h");
  expect(resetCountdown(null, now)).toBeNull();
});
