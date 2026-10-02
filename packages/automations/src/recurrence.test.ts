import { describe, expect, it } from "vitest";
import { compileSchedule, nextOccurrence } from "./index.ts";
import type { AutomationSchedule } from "@ace/protocol";
const at = (value: string) => Date.parse(value);
function schedule(
  expression: string,
  kind: AutomationSchedule["kind"] = "rrule",
  start = "2024-01-01T09:00:00Z",
  timezone = "UTC",
): AutomationSchedule {
  return { expression, kind, startAt: at(start), timezone };
}
function dates(input: AutomationSchedule, after: string, n: number): string[] {
  const recurrence = compileSchedule(input);
  let cursor = at(after);
  const result: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = recurrence.next(cursor);
    if (next === undefined) break;
    result.push(new Date(next).toISOString());
    cursor = next;
  }
  return result;
}
describe("calendar recurrence", () => {
  it("runs weekdays at nine in the user's timezone across spring DST", () => {
    const s = schedule(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
      "rrule",
      "2024-03-08T15:00:00Z",
      "America/Chicago",
    );
    expect(dates(s, "2024-03-07T00:00:00Z", 3)).toEqual([
      "2024-03-08T15:00:00.000Z",
      "2024-03-11T14:00:00.000Z",
      "2024-03-12T14:00:00.000Z",
    ]);
  });
  it.each(["rrule", "cron"] as const)("skips a nonexistent spring wall time for %s", (kind) => {
    const s = schedule(
      kind === "rrule" ? "FREQ=DAILY;BYHOUR=2;BYMINUTE=30" : "30 2 * * *",
      kind,
      "2024-03-09T07:30:00Z",
      "America/New_York",
    );
    expect(dates(s, "2024-03-09T07:30:00Z", 2)).toEqual([
      "2024-03-11T06:30:00.000Z",
      "2024-03-12T06:30:00.000Z",
    ]);
  });
  it.each(["rrule", "cron"] as const)(
    "runs a repeated autumn wall time only at its first instant for %s",
    (kind) => {
      const s = schedule(
        kind === "rrule" ? "FREQ=DAILY;BYHOUR=1;BYMINUTE=30" : "30 1 * * *",
        kind,
        "2024-11-02T05:30:00Z",
        "America/New_York",
      );
      expect(dates(s, "2024-11-02T05:30:00Z", 2)).toEqual([
        "2024-11-03T05:30:00.000Z",
        "2024-11-04T06:30:00.000Z",
      ]);
      expect(dates(s, "2024-11-03T06:00:00Z", 1)).toEqual(["2024-11-04T06:30:00.000Z"]);
    },
  );
  it("skips the half-hour spring gap on Lord Howe", () => {
    expect(
      dates(
        schedule("15 2 * * *", "cron", "2024-10-04T15:45:00Z", "Australia/Lord_Howe"),
        "2024-10-04T15:45:00Z",
        1,
      ),
    ).toEqual(["2024-10-06T15:15:00.000Z"]);
  });
  it("does not shift monthly day 31 into a shorter month", () => {
    expect(
      dates(schedule("FREQ=MONTHLY", "rrule", "2024-01-31T09:00:00Z"), "2024-01-30T00:00:00Z", 4),
    ).toEqual([
      "2024-01-31T09:00:00.000Z",
      "2024-03-31T09:00:00.000Z",
      "2024-05-31T09:00:00.000Z",
      "2024-07-31T09:00:00.000Z",
    ]);
  });
  it("annual leap-day recurrence skips common and century non-leap years", () => {
    expect(
      dates(schedule("FREQ=YEARLY", "rrule", "2096-02-29T09:00:00Z"), "2096-02-29T09:00:00Z", 2),
    ).toEqual(["2104-02-29T09:00:00.000Z", "2108-02-29T09:00:00.000Z"]);
  });
  it("cron finds leap days without scanning every minute of intervening years", () => {
    expect(dates(schedule("0 9 29 2 *", "cron"), "2024-03-01T00:00:00Z", 1)).toEqual([
      "2028-02-29T09:00:00.000Z",
    ]);
  });
  it("COUNT counts DTSTART and valid occurrences, excluding skipped DST times", () => {
    const s = schedule("FREQ=DAILY;COUNT=3", "rrule", "2024-03-09T07:30:00Z", "America/New_York");
    expect(dates(s, "2024-03-09T00:00:00Z", 5)).toEqual([
      "2024-03-09T07:30:00.000Z",
      "2024-03-11T06:30:00.000Z",
      "2024-03-12T06:30:00.000Z",
    ]);
    expect(nextOccurrence(s, at("2025-01-01T00:00:00Z"))).toBeUndefined();
  });
  it("UNTIL is inclusive and applies to expanded times", () => {
    expect(
      dates(schedule("FREQ=DAILY;BYHOUR=9,15;UNTIL=20240102T090000Z"), "2024-01-01T00:00:00Z", 9),
    ).toEqual(["2024-01-01T09:00:00.000Z", "2024-01-01T15:00:00.000Z", "2024-01-02T09:00:00.000Z"]);
  });
  it.each([
    ["FREQ=MINUTELY;INTERVAL=17", "2024-01-01T09:17:00.000Z"],
    ["FREQ=HOURLY;INTERVAL=3;BYMINUTE=10,20", "2024-01-01T09:10:00.000Z"],
    ["FREQ=DAILY;INTERVAL=2", "2024-01-03T09:00:00.000Z"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR", "2024-01-05T09:00:00.000Z"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "2024-01-26T09:00:00.000Z"],
    ["FREQ=YEARLY;BYDAY=2MO", "2024-01-08T09:00:00.000Z"],
  ])("applies interval and calendar filters in %s", (expression, expected) => {
    expect(dates(schedule(expression), "2024-01-01T09:00:00Z", 1)).toEqual([expected]);
  });
  it("hourly BYHOUR filters rather than expanding outside the interval", () => {
    expect(
      dates(schedule("FREQ=HOURLY;INTERVAL=3;BYHOUR=12;BYMINUTE=15"), "2024-01-01T09:00:00Z", 2),
    ).toEqual(["2024-01-01T12:15:00.000Z", "2024-01-02T12:15:00.000Z"]);
  });
  it("cron supports lists, range steps and Sunday 7", () => {
    expect(dates(schedule("0,30 8-10/2 * * 7", "cron"), "2024-01-06T00:00:00Z", 3)).toEqual([
      "2024-01-07T08:00:00.000Z",
      "2024-01-07T08:30:00.000Z",
      "2024-01-07T10:00:00.000Z",
    ]);
  });
  it("cron uses OR for two restricted day fields", () => {
    expect(dates(schedule("0 9 1 * 5", "cron"), "2024-01-01T09:00:00Z", 2)).toEqual([
      "2024-01-05T09:00:00.000Z",
      "2024-01-12T09:00:00.000Z",
    ]);
  });
  it("cron wildcard steps still constrain weekdays with AND", () => {
    expect(dates(schedule("0 9 */2 * 1", "cron"), "2024-01-01T09:00:00Z", 2)).toEqual([
      "2024-01-15T09:00:00.000Z",
      "2024-01-29T09:00:00.000Z",
    ]);
  });
  it.each([
    "FREQ=DAILY;BYMONTH=3",
    "FREQ=DAILY;COUNT=2;UNTIL=20240101T000000Z",
    "FREQ=WEEKLY;BYDAY=1MO",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;BYHOUR=24",
    "FREQ=DAILY;UNTIL=20240230T000000Z",
    "FREQ=DAILY;FREQ=WEEKLY",
  ])("rejects unsupported or invalid rules: %s", (expression) =>
    expect(() => compileSchedule(schedule(expression))).toThrow(),
  );
  it.each(["0 24 * * *", "0 9 * * MON", "0 9 * *", "0 9 2-1 * *", "0 9 * * */0"])(
    "rejects invalid cron: %s",
    (expression) => expect(() => compileSchedule(schedule(expression, "cron"))).toThrow(),
  );
  it("reports a bounded search failure rather than claiming an impossible schedule ended", () => {
    expect(() =>
      nextOccurrence(schedule("0 9 30 2 *", "cron"), at("2024-01-01T00:00:00Z")),
    ).toThrow("horizon");
  });
});
it("advances counted recurrence from a supplied cursor with the same result as full evaluation", () => {
  const recurrence = compileSchedule(schedule("FREQ=DAILY;COUNT=6"));
  const first = recurrence.seek(at("2024-01-01T08:00:00Z"));
  expect(first).toEqual({ at: at("2024-01-01T09:00:00Z"), ordinal: 1 });
  const next = recurrence.seek(at("2024-01-03T12:00:00Z"), first);
  expect(next).toEqual({ at: at("2024-01-04T09:00:00Z"), ordinal: 4 });
  expect(next?.at).toBe(recurrence.next(at("2024-01-03T12:00:00Z")));
  expect(recurrence.seek(at("2024-01-07T00:00:00Z"), next)).toBeUndefined();
});
it("expands BYMINUTE within the hourly interval anchored at the civil hour", () => {
  const s = schedule("FREQ=HOURLY;INTERVAL=2;BYMINUTE=0,30", "rrule", "2026-01-01T09:30:00Z");
  expect(dates(s, "2026-01-01T09:30:00Z", 4)).toEqual([
    "2026-01-01T11:00:00.000Z",
    "2026-01-01T11:30:00.000Z",
    "2026-01-01T13:00:00.000Z",
    "2026-01-01T13:30:00.000Z",
  ]);
});
