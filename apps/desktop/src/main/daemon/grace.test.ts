import { describe, expect, it } from "vitest";
import {
  healthVerdict,
  restartBackoff,
  startupCeilingMs,
  startupVerdict,
  type StallReading,
  type UnresponsiveFacts,
} from "./grace.ts";

const calm = { heavy: false, reasons: [] };
const heavy = { heavy: true, reasons: ["load 96 on 16 CPUs"] };
/** The incident's numbers: 39 s silent, 107 ms of CPU, the watchdog itself ran late. */
const starved: StallReading = { silentMs: 38_911, cpuMs: 107, watchdogLateMs: 4_000, ageMs: 1_000 };
const spinning: StallReading = { silentMs: 30_000, cpuMs: 29_500, watchdogLateMs: 0, ageMs: 1_000 };
const blocked: StallReading = { silentMs: 30_000, cpuMs: 40, watchdogLateMs: 0, ageMs: 1_000 };

const facts = (patch: Partial<UnresponsiveFacts>): UnresponsiveFacts => ({
  unansweredMs: 45_000,
  graces: 0,
  pressure: undefined,
  stall: undefined,
  ...patch,
});

describe("an unanswered daemon", () => {
  it.each([
    ["starved on an overloaded machine", facts({ pressure: heavy, stall: starved }), "wait"],
    ["starved by its own watchdog's numbers, load unread", facts({ stall: starved }), "wait"],
    ["silent on an overloaded machine, no stall report", facts({ pressure: heavy }), "wait"],
    ["silent on an idle machine", facts({ pressure: calm }), "stop"],
    ["silent with nothing known", facts({}), "stop"],
    ["spinning on an idle machine", facts({ pressure: calm, stall: spinning }), "stop"],
    ["blocked on an idle machine", facts({ pressure: calm, stall: blocked }), "stop"],
    [
      "starved, but its report is stale on an idle machine",
      facts({ pressure: calm, stall: { ...starved, ageMs: 60_000 } }),
      "stop",
    ],
    [
      "starved past the ceiling",
      facts({ pressure: heavy, stall: starved, unansweredMs: 300_000 }),
      "stop",
    ],
  ])("%s: %s", (_name, input, kind) => {
    expect(healthVerdict(input).kind).toBe(kind);
  });

  it("each grace doubles, up to two minutes", () => {
    const graces = [0, 1, 2, 3, 4, 5].map((count) => {
      const verdict = healthVerdict(facts({ pressure: heavy, graces: count }));
      return verdict.kind === "wait" ? verdict.graceMs : 0;
    });
    expect(graces).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  });
});

describe("a start past its ready budget", () => {
  it.each([
    ["still writing its log", { waitedMs: 120_000, progressed: true, pressure: calm }, "wait"],
    [
      "quiet on an overloaded machine",
      { waitedMs: 120_000, progressed: false, pressure: heavy },
      "wait",
    ],
    ["quiet on an idle machine", { waitedMs: 120_000, progressed: false, pressure: calm }, "stop"],
    [
      "still writing past the ceiling",
      { waitedMs: startupCeilingMs, progressed: true, pressure: heavy },
      "stop",
    ],
  ])("%s: %s", (_name, input, kind) => {
    expect(startupVerdict(input).kind).toBe(kind);
  });
});

describe("the wait before a restart", () => {
  it("is the crash backoff on a calm machine", () => {
    expect(restartBackoff(500, 0, false)).toBe(500);
    expect(restartBackoff(8_000, 4, false)).toBe(8_000);
  });

  it("grows from 5 s to two minutes on an overloaded machine", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) =>
      restartBackoff(500 * 2 ** attempt, attempt, true),
    );
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000]);
  });
});
