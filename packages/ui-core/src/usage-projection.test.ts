import { expect, test } from "vitest";
import { projectedLeft } from "./usage-limits.ts";
import { limitTime, roundEstimate } from "./usage-projection.ts";

const now = Date.parse("2026-11-11T16:00:00Z");
const minute = 60_000;
const hour = 60 * minute;

test("a window used at an even pace has its unused share left when it resets", () => {
  // A tenth of five hours used in its first hour: four more tenths by the reset, half left.
  expect(projectedLeft(10, now + 4 * hour, 300, now)).toBe(50);
});

test("a window that runs out before its reset has nothing to mark", () => {
  // Half used in the first hour of five.
  expect(projectedLeft(50, now + 4 * hour, 300, now)).toBeNull();
});

test("an untouched window keeps all of it; one too young or without a length can't say", () => {
  expect(projectedLeft(0, now + 4 * hour, 300, now)).toBe(100);
  expect(projectedLeft(5, now + 298 * minute, 300, now)).toBeNull();
  expect(projectedLeft(20, now + hour, undefined, now)).toBeNull();
});

test("times read as a clock today and a weekday further out; estimates round", () => {
  expect(limitTime(now + 72 * minute, now, "UTC", "en-GB")).toBe("17:12");
  expect(limitTime(now + 3 * 24 * hour, now, "UTC", "en-GB")).toBe("Sat 16:00");
  expect(roundEstimate(now + 52 * minute, now)).toBe(now + 50 * minute);
  expect(roundEstimate(now + 30 * hour + 20 * minute, now)).toBe(now + 30 * hour);
});
