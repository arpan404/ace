import type { AutomationSchedule } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  describeSchedule,
  formatRunInZone,
  presetToSchedule,
  scheduleToPreset,
  upcomingRuns,
} from "./schedule.ts";

// 2026-10-02T14:45:00Z: a start instant whose wall clock differs by zone.
const startAt = Date.UTC(2026, 9, 2, 14, 45);
const rrule = (expression: string, timezone = "UTC"): AutomationSchedule => ({
  kind: "rrule",
  expression,
  timezone,
  startAt,
});
const cron = (expression: string): AutomationSchedule => ({
  kind: "cron",
  expression,
  timezone: "UTC",
  startAt,
});

test("RRULEs read as people say them", () => {
  expect(describeSchedule(rrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;BYHOUR=8;BYMINUTE=30"))).toBe(
    "Every 2 weeks on Mondays and Thursdays at 08:30",
  );
  expect(describeSchedule(rrule("FREQ=MINUTELY;INTERVAL=15"))).toBe("Every 15 minutes");
  expect(describeSchedule(rrule("FREQ=HOURLY"))).toBe("Every hour");
  expect(describeSchedule(rrule("RRULE:FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0"))).toBe(
    "Every month at 09:00",
  );
});

test("a rule without BYHOUR fires at its start time in its own zone", () => {
  expect(describeSchedule(rrule("FREQ=DAILY", "Asia/Kolkata"))).toBe("Every day at 20:15");
  expect(describeSchedule(rrule("FREQ=DAILY", "America/Chicago"))).toBe("Every day at 09:45");
});

test("common cron shapes read as words and unusual ones stay as written", () => {
  expect(describeSchedule(cron("*/10 * * * *"))).toBe("Every 10 minutes");
  expect(describeSchedule(cron("0 */4 * * *"))).toBe("Every 4 hours");
  expect(describeSchedule(cron("0 16 * * 5"))).toBe("Fridays at 16:00");
  expect(describeSchedule(cron("15 9 * * 0,6"))).toBe("Saturdays and Sundays at 09:15");
  expect(describeSchedule(cron("0 9 1 * *"))).toBe("Day 1 of every month at 09:00");
  expect(describeSchedule(cron("30 8 1 3 *"))).toBe("1 March every year at 08:30");
  expect(describeSchedule(cron("0 9 1-7 * 1"))).toBe("Cron 0 9 1-7 * 1");
});

test("every form preset survives a round trip through its RRULE", () => {
  const presets = [
    { kind: "daily", time: "02:00" },
    { kind: "weekdays", time: "08:30" },
    { kind: "weekly", day: "SU", time: "23:59" },
    { kind: "hourly", every: 6 },
  ] as const;
  for (const preset of presets)
    expect(scheduleToPreset(presetToSchedule(preset, "Europe/Berlin", startAt))).toEqual(preset);
});

test("the next starts follow the daemon's rules, in the schedule's own zone", () => {
  const schedule = rrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "Europe/London");
  const runs = upcomingRuns(schedule, startAt).map((at) => formatRunInZone(at, "Europe/London"));
  expect(runs).toEqual(["Sat 3 Oct 09:00", "Sun 4 Oct 09:00", "Mon 5 Oct 09:00"]);
});
