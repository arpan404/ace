import { expect, test } from "vitest";
import { describeWake, snoozePresets } from "./snooze.ts";

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
