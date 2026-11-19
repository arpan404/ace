import { expect, test } from "vitest";
import { customScheduleError } from "./schedule-validate.ts";

const startAt = Date.UTC(2026, 9, 2, 14, 0);

test("FREQ=BOGUS fails validation instead of reading back as no upcoming run", () => {
  expect(
    customScheduleError({ kind: "rrule", expression: "FREQ=BOGUS", timezone: "UTC", startAt }),
  ).toMatch(/valid RRULE/i);
});

test("a valid custom RRULE and cron pass while a short cron fails", () => {
  expect(
    customScheduleError({
      kind: "rrule",
      expression: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=30",
      timezone: "UTC",
      startAt,
    }),
  ).toBeUndefined();
  expect(
    customScheduleError({ kind: "cron", expression: "30 7 * * 1-5", timezone: "UTC", startAt }),
  ).toBeUndefined();
  expect(
    customScheduleError({ kind: "cron", expression: "30 7 * *", timezone: "UTC", startAt }),
  ).toMatch(/valid cron/i);
});
