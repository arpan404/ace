import { expect, test } from "vitest";
import { describeWake, snoozeBefore, snoozedToast, snoozeLabel, snoozePresets } from "./snooze.ts";

const at = (text: string) => new Date(text).getTime();
const presets = (now: string) =>
  Object.fromEntries(snoozePresets(at(now), "en-US").map((p) => [p.id, new Date(p.until)]));

test("snooze presets wake in an hour, tomorrow at 9 and the next Monday at 9", () => {
  const thursday = presets("2026-10-01T15:32:00");
  expect(thursday.hour?.getTime()).toBe(at("2026-10-01T16:32:00"));
  expect(thursday.tomorrow?.getTime()).toBe(at("2026-10-02T09:00:00"));
  expect(thursday.monday?.getTime()).toBe(at("2026-10-05T09:00:00"));
});

test("next Monday is never today: from a Monday it is a week away, from Sunday it is tomorrow", () => {
  expect(presets("2026-10-05T08:00:00").monday?.getTime()).toBe(at("2026-10-12T09:00:00"));
  expect(presets("2026-10-04T20:00:00").monday?.getTime()).toBe(at("2026-10-05T09:00:00"));
});

test("wake times read as today, tomorrow, a weekday or a date", () => {
  const now = at("2026-10-01T15:32:00");
  expect(describeWake(at("2026-10-01T16:32:00"), now, "en-US")).toBe("4:32 PM");
  expect(describeWake(at("2026-10-02T09:00:00"), now, "en-US")).toBe("tomorrow 9:00 AM");
  expect(describeWake(at("2026-10-05T09:00:00"), now, "en-US")).toBe("Mon 9:00 AM");
  expect(describeWake(at("2026-10-20T09:00:00"), now, "en-US")).toBe("Oct 20, 9:00 AM");
});

test("Undo of a snooze puts back the one still ahead, with its event, and otherwise wakes it", () => {
  const now = at("2026-10-01T15:32:00");
  const later = at("2026-10-02T09:00:00");
  const cases = [
    { before: {}, undo: { until: null } },
    { before: { snoozedUntil: later }, undo: { until: later } },
    {
      before: { snoozedUntil: later, snoozeWake: { on: "needs_you" as const } },
      undo: { until: later, wake: "needs_you" },
    },
    // One already over (its time came, it woke) has nothing to put back.
    {
      before: { snoozedUntil: now - 1, snoozeWake: { on: "needs_you" as const } },
      undo: { until: null },
    },
    { before: { snoozedUntil: now }, undo: { until: null } },
  ];
  for (const { before, undo } of cases) expect(snoozeBefore(before, now)).toEqual(undo);
});

test("a snooze's toast says what it waits for, then the thread", () => {
  const now = at("2026-10-01T15:32:00");
  const wakes = snoozeLabel({ snoozedUntil: at("2026-10-02T09:00:00") }, now, "en-US");
  expect(snoozedToast("Fix login", wakes)).toBe("Snoozed until tomorrow 9:00 AM · Fix login");
  expect(snoozedToast("Fix login", "until it needs you")).toBe(
    "Snoozed until it needs you · Fix login",
  );
  expect(snoozedToast("Fix login", undefined)).toBe("Snoozed · Fix login");
});
