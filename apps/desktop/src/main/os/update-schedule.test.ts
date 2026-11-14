import { describe, expect, it } from "vitest";
import { scheduleChecks, type UpdateSchedule } from "./update-schedule.ts";

const schedule: UpdateSchedule = {
  afterDaemonMs: 5_000,
  launchLatestMs: 60_000,
  everyMs: 60_000,
  idleEveryMs: 1_800_000,
  spread: 0.5,
  openGapMs: 30_000,
};

/** The app's clock and timers, a feed that counts its requests, and whether the app is in use. */
function app(options: { draws?: number[] } = {}) {
  let clock = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  const checks: number[] = [];
  const daemon = Promise.withResolvers<void>();
  const state = { active: true };
  const draws = options.draws ?? [];
  const checker = {
    check: async () => void checks.push(clock),
  };
  const checkSchedule = scheduleChecks(
    checker,
    {
      timers: {
        set(delayMs, callback) {
          const timer = { at: clock + delayMs, callback };
          timers.add(timer);
          return () => timers.delete(timer);
        },
      },
      random: () => draws.shift() ?? 0,
      now: () => clock,
      active: () => state.active,
      daemonRunning: daemon.promise,
    },
    schedule,
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    schedule: checkSchedule,
    state,
    checks,
    daemonRunning: async () => {
      daemon.resolve();
      await settle();
    },
    async advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        await settle();
        const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        clock = next.at;
        next.callback();
      }
      clock = until;
      await settle();
    },
  };
}

describe("background update checks", () => {
  it("wait for the daemon to run, then check a few seconds later", async () => {
    const a = app();
    await a.advance(20_000);
    expect(a.checks).toEqual([]);
    await a.daemonRunning();
    await a.advance(4_999);
    expect(a.checks).toEqual([]);
    await a.advance(1);
    expect(a.checks).toEqual([25_000]);
  });

  it("check within a minute of launch even when the daemon never runs", async () => {
    const a = app();
    await a.advance(60_000);
    expect(a.checks).toEqual([60_000]);
  });

  it("opening the window at launch does not jump ahead of the daemon's start", async () => {
    const a = app();
    a.schedule.opened();
    await a.advance(1_000);
    expect(a.checks).toEqual([]);
  });

  it("check about every minute while the app is in use, each wait offset at random", async () => {
    const a = app({ draws: [0, 1] });
    await a.daemonRunning();
    await a.advance(5_000);
    await a.advance(60_000);
    await a.advance(90_000);
    // Each wait is its base plus up to half again, by the random draw.
    expect(a.checks).toEqual([5_000, 65_000, 155_000]);
  });

  it("no check while hidden or on battery within the half-hour back-off", async () => {
    const a = app();
    await a.daemonRunning();
    await a.advance(5_000);
    a.state.active = false;
    await a.advance(60_000);
    // The wait chosen while in use ends; the next one is the back-off.
    expect(a.checks).toEqual([5_000, 65_000]);
    await a.advance(1_799_999);
    expect(a.checks).toEqual([5_000, 65_000]);
    await a.advance(1);
    expect(a.checks).toEqual([5_000, 65_000, 1_865_000]);
  });

  it("opening the window after a gap checks at once, then every minute again", async () => {
    const a = app();
    await a.daemonRunning();
    await a.advance(5_000);
    a.state.active = false;
    await a.advance(600_000);
    a.state.active = true;
    a.schedule.opened();
    await a.advance(0);
    expect(a.checks).toEqual([5_000, 65_000, 605_000]);
    await a.advance(60_000);
    expect(a.checks.at(-1)).toBe(665_000);
  });

  it("opening the window right after a check asks the feed only once", async () => {
    const a = app();
    await a.daemonRunning();
    await a.advance(5_000);
    await a.advance(10_000);
    a.schedule.opened();
    await a.advance(0);
    expect(a.checks).toEqual([5_000]);
    await a.advance(20_000);
    a.schedule.opened();
    await a.advance(0);
    expect(a.checks).toEqual([5_000, 35_000]);
  });
});
