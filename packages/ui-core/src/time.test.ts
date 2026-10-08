import { expect, test } from "vitest";
import { formatAge, formatAgo, formatElapsed, formatSpan, formatClock } from "./time.ts";

const s = 1000;
const m = 60 * s;
const h = 60 * m;
const d = 24 * h;

test("list ages read now, minutes, hours, days, then weeks", () => {
  expect(formatAge(1000, 1000 + 30 * s)).toBe("now");
  expect(formatAge(0, 2 * m)).toBe("2m");
  expect(formatAge(0, 3 * h)).toBe("3h");
  expect(formatAge(0, 4 * d)).toBe("4d");
  expect(formatAge(0, 42 * d)).toBe("6w");
});

test("an age inside a sentence reads just now, then so long ago", () => {
  expect(formatAgo(0, 10 * s)).toBe("just now");
  expect(formatAgo(0, 12 * m)).toBe("12m ago");
});

test("an age in the future, from clock skew, reads now", () => {
  expect(formatAge(10 * m, 0)).toBe("now");
});

test("elapsed turn time keeps seconds until an hour", () => {
  expect(formatElapsed(38 * s)).toBe("38s");
  expect(formatElapsed(4 * m + 12 * s)).toBe("4m 12s");
  expect(formatElapsed(h + 2 * m)).toBe("1h 2m");
});

test("a run span rounds to minutes and drops a zero remainder", () => {
  expect(formatSpan(0, 42 * s)).toBe("42s");
  expect(formatSpan(0, 6 * m + 20 * s)).toBe("6m");
  expect(formatSpan(0, h + 12 * m)).toBe("1h 12m");
  expect(formatSpan(0, 2 * h)).toBe("2h");
});

test("reset clocks follow the locale's 12 or 24 hour setting without padding the hour", () => {
  const at = new Date(2026, 0, 2, 13, 33).getTime();
  expect(formatClock(at, "en-US")).toBe("1:33 PM");
  expect(formatClock(at, "en-GB")).toBe("13:33");
});
