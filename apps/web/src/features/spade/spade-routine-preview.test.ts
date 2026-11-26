import { expect, test } from "vitest";
import { nextRunOf, routineNameOf } from "./spade-routine-preview.ts";

// Wednesday 2026-11-25, 10:30 local.
const now = new Date(2026, 10, 25, 10, 30).getTime();
const at = (day: number, hour: number, mins = 0) => new Date(2026, 10, day, hour, mins).getTime();

test("a daily time already past today fires tomorrow, one still ahead fires today", () => {
  expect(nextRunOf("daily at 9:00", now)).toBe(at(26, 9));
  expect(nextRunOf("every day at 6pm", now)).toBe(at(25, 18));
});

test("weekday and weekend phrases skip the days they don't name", () => {
  expect(nextRunOf("weekdays at 9am", at(27, 12))).toBe(at(30, 9)); // Friday noon -> Monday
  expect(nextRunOf("weekends at 10:30", now)).toBe(at(28, 10, 30));
  expect(nextRunOf("mondays and thursdays at 6:30pm", now)).toBe(at(26, 18, 30));
});

test("several times in one phrase give the nearest one ahead", () => {
  expect(nextRunOf("at 7:00 and 19:00", now)).toBe(at(25, 19));
});

test("intervals count from the epoch", () => {
  expect(nextRunOf("every 2 hours", now)! % (2 * 3_600_000)).toBe(0);
  expect(nextRunOf("every hour", now)! - now).toBeLessThanOrEqual(3_600_000);
});

test("a phrase it can't read gives no preview", () => {
  expect(nextRunOf("whenever", now)).toBeUndefined();
  expect(nextRunOf("daily at 25:00", now)).toBeUndefined();
});

test("a routine's name is its first line, cut at a word", () => {
  expect(routineNameOf("Check new issues and label them\nthen report")).toBe(
    "Check new issues and label them",
  );
  expect(
    routineNameOf("Go through every open pull request in the relay repository and comment").length,
  ).toBeLessThanOrEqual(49);
});
