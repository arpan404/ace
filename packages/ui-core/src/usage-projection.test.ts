import { expect, test } from "vitest";
import { projectedLeft } from "./usage-limits.ts";
import type { AccountWindow } from "./usage-limits.ts";
import { limitDetails, limitTime, roundEstimate } from "./usage-projection.ts";

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

const window = (extra: Partial<AccountWindow>): AccountWindow => ({
  id: "w",
  label: "Session (5h)",
  leftPercent: 90,
  resetsAt: now + 4 * hour,
  pace: "on_pace",
  observedAt: now - 2 * minute,
  stale: false,
  evenLeftPercent: 80,
  runsOutAt: null,
  startsAt: now - hour,
  leftAtReset: 50,
  ...extra,
});
const read = (lines: ReturnType<typeof limitDetails>) =>
  Object.fromEntries(lines.map((line) => [line.label, line.value]));

test("a limit's card says what is left, where its pace leads, and when it resets and began", () => {
  expect(read(limitDetails(window({}), now, "UTC", "en-GB"))).toEqual({
    Now: "90% left · 10% used",
    "At this pace": "About 50% left at the reset",
    Pace: "About even with the window",
    Resets: "20:00 · in 4h",
    Began: "15:00",
    Read: "2m ago",
  });
});

test("a limit that runs out says when, as a warning", () => {
  const lines = limitDetails(
    window({ leftPercent: 50, pace: "ahead", runsOutAt: now + hour, leftAtReset: null }),
    now,
    "UTC",
    "en-GB",
  );
  expect(lines.find((line) => line.label === "At this pace")).toEqual({
    label: "At this pace",
    value: "Runs out around 17:00",
    tone: "out",
  });
  expect(read(lines).Pace).toBe("Faster than the window runs");
});

test("a week that began days ago says the date it began, not a weekday its reset shares", () => {
  const week = window({ startsAt: now - 3 * 24 * hour, resetsAt: now + 4 * 24 * hour });
  expect(read(limitDetails(week, now, "UTC", "en-GB")).Began).toBe("8 Nov, 16:00");
});

test("a reading older than its reset says only that, and how old it is", () => {
  expect(
    read(limitDetails(window({ stale: true, resetsAt: now - hour }), now, "UTC", "en-GB")),
  ).toEqual({ Now: "Not used since its reset", Reset: "1h ago", Read: "2m ago" });
});
