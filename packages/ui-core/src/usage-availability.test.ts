import { expect, test } from "vitest";
import {
  accountAvailability,
  availabilityAxis,
  availabilitySentence,
  axisPercent,
  axisTicks,
} from "./usage-availability.ts";
import type { AccountLimits, AccountWindow } from "./usage-limits.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** Wednesday 11 November 2026, 16:00 UTC. */
const now = Date.parse("2026-11-11T16:00:00Z");
const axis = availabilityAxis(now);
const zone = "UTC";
const locale = "en-GB";

/** A window `left`% left, `length` long, resetting `resetsIn` from now, at its pace so far. */
function window(
  label: string,
  left: number,
  length: number,
  resetsIn: number,
  extra: Partial<AccountWindow> = {},
): AccountWindow {
  const resetsAt = now + resetsIn;
  const startsAt = resetsAt - length;
  const used = 100 - left;
  const ran = now - startsAt;
  const outAt = used > 0 ? now + (left / used) * ran : null;
  return {
    id: label,
    label,
    leftPercent: left,
    resetsAt,
    startsAt,
    pace: undefined,
    observedAt: now,
    stale: false,
    evenLeftPercent: undefined,
    runsOutAt: outAt !== null && outAt < resetsAt ? outAt : null,
    ...extra,
  };
}

const account = (...windows: AccountWindow[]) => ({ windows }) as Pick<AccountLimits, "windows">;
const availability = (...windows: AccountWindow[]) =>
  accountAvailability(account(...windows) as AccountLimits, axis);
const sentence = (...windows: AccountWindow[]) =>
  availabilitySentence(availability(...windows), now, zone, locale);

test("the next five hours take the first 30% of the timeline and the rest of the week the remainder", () => {
  expect(axisPercent(axis, now)).toBe(0);
  expect(axisPercent(axis, now + 5 * hour)).toBe(30);
  expect(axisPercent(axis, now + 7 * day)).toBe(100);
  expect(axisPercent(axis, now + 9 * day)).toBe(100);
});

test("the timeline names now, the hours ahead, then each day from its midnight", () => {
  const ticks = axisTicks(axis, zone, locale);
  expect(ticks[0]).toMatchObject({ label: "Now", kind: "now" });
  expect(ticks.filter((tick) => tick.kind === "hour").map((tick) => tick.label)).toEqual([
    "18:00",
    "20:00",
  ]);
  expect(ticks.filter((tick) => tick.kind === "day").map((tick) => tick.label)).toEqual([
    "Thu",
    "Fri",
    "Sat",
    "Sun",
    "Mon",
    "Tue",
    "Wed",
  ]);
  expect(ticks.find((tick) => tick.label === "Thu")?.at).toBe(Date.parse("2026-11-12T00:00:00Z"));
});

test("a session used faster than it runs is out from when it runs out until it resets", () => {
  // 82% used 3h48m into five hours: out in about 50m, back at its reset in 1h12m.
  const session = window("Session (5h)", 18, 5 * hour, 72 * minute);
  const result = availability(session);
  expect(result.stretches.map((stretch) => stretch.out)).toEqual([false, true, false]);
  expect(result.stretches[1]?.to).toBe(now + 72 * minute);
  expect(sentence(session)).toEqual({
    text: "Session runs out around 16:50, back 17:12",
    tone: "low",
  });
});

test("an account already out says so and is out from now", () => {
  const weekly = window("Weekly", 0, 7 * day, 2 * day);
  expect(availability(weekly).stretches[0]).toEqual({ from: now, to: now + 2 * day, out: true });
  expect(sentence(weekly)).toEqual({ text: "Weekly is out, back Fri 16:00", tone: "out" });
});

test("overlapping lockouts read as one, back only when the later window resets", () => {
  const session = window("Session (5h)", 0, 5 * hour, hour);
  const weekly = window("Weekly", 1, 7 * day, 3 * day);
  const result = availability(session, weekly);
  expect(result.stretches.filter((stretch) => stretch.out)).toHaveLength(1);
  expect(result.lockout?.until).toBe(now + 3 * day);
  expect(sentence(session, weekly).text).toBe("Session is out, back Sat 16:00");
});

test("a session out now and a week that runs out later are both said, soonest first", () => {
  const session = window("Session (5h)", 0, 5 * hour, hour);
  // 70% used 55h into the week: out in about 23.6h, long before its reset in 113h.
  const weekly = window("Weekly", 30, 7 * day, 113 * hour);
  expect(availability(session, weekly).stretches.filter((stretch) => stretch.out)).toHaveLength(2);
  expect(sentence(session, weekly)).toEqual({
    text: "Session is out, back 17:00. Weekly runs out around Thu 15:35, back Mon 9:00",
    tone: "out",
  });
});

test("an account that lasts names the window with the least to spare at its reset", () => {
  // Weekly: 23% used 74h in, so about 52% used by its reset in 94h; session barely touched.
  const session = window("Session (5h)", 90, 5 * hour, 200 * minute);
  const weekly = window("Weekly", 77, 7 * day, 94 * hour);
  const result = availability(session, weekly);
  expect(result.stretches).toEqual([{ from: now, to: now + 7 * day, out: false }]);
  expect(sentence(session, weekly)).toEqual({
    text: "Lasts. Weekly resets Sun 14:00 with about 48% to spare",
    tone: "ok",
  });
});

test("windows past their reset draw nothing and say their reading is old", () => {
  const stale = window("Weekly", 40, 7 * day, -hour, { stale: true });
  expect(availability(stale).stretches).toEqual([]);
  expect(sentence(stale).text).toBe("Not used since its last reset");
});

test("a lockout further out than a week stays off the timeline", () => {
  // 1% used two days into a 30-day window would run out months away.
  const monthly = window("Monthly", 50, 30 * day, 20 * day);
  const result = availability({ ...monthly, runsOutAt: now + 10 * day });
  expect(result.stretches).toEqual([{ from: now, to: now + 7 * day, out: false }]);
});
