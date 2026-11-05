import { expect, test } from "vitest";
import { watchMemory } from "./memory-watchdog.ts";

/** A manual clock: each scheduled poll runs when the test says. */
function manualClock() {
  const pending: { run: () => void; milliseconds: number; cancelled: boolean }[] = [];
  return {
    pending,
    schedule(run: () => void, milliseconds: number) {
      const entry = { run, milliseconds, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Runs the next poll and lets its sample settle. */
    async tick() {
      const next = pending.shift();
      if (!next) throw new Error("Nothing scheduled");
      if (!next.cancelled) next.run();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("a process is reported once, with the reading, the first time it goes over its limit", async () => {
  const clock = manualClock();
  const readings = [100, 200, 301, 400];
  const exceeded: number[] = [];
  watchMemory({
    pid: 7,
    limitBytes: 300,
    intervalMs: 100,
    sample: async () => readings.shift(),
    schedule: clock.schedule,
    onExceeded: (bytes) => exceeded.push(bytes),
  });
  await clock.tick();
  await clock.tick();
  expect(exceeded).toEqual([]);
  await clock.tick();
  expect(exceeded).toEqual([301]);
  // Watching ends with the report.
  expect(clock.pending).toEqual([]);
});

test("polls run at the interval and skip readings that fail, then stop when told to", async () => {
  const clock = manualClock();
  const exceeded: number[] = [];
  let calls = 0;
  const stop = watchMemory({
    pid: 7,
    limitBytes: 300,
    intervalMs: 250,
    sample: async () => {
      calls++;
      if (calls === 1) throw new Error("gone for a moment");
      return calls === 2 ? undefined : 100;
    },
    schedule: clock.schedule,
    onExceeded: (bytes) => exceeded.push(bytes),
  });
  for (let i = 0; i < 3; i++) await clock.tick();
  expect(calls).toBe(3);
  expect(clock.pending.map((entry) => entry.milliseconds)).toEqual([250]);
  stop();
  await clock.tick();
  expect(calls).toBe(3);
  expect(exceeded).toEqual([]);
});

test("a reading that settles after the stop is ignored", async () => {
  const clock = manualClock();
  const exceeded: number[] = [];
  let answer: ((bytes: number) => void) | undefined;
  const stop = watchMemory({
    pid: 7,
    limitBytes: 300,
    intervalMs: 100,
    sample: () => new Promise((resolve) => (answer = resolve)),
    schedule: clock.schedule,
    onExceeded: (bytes) => exceeded.push(bytes),
  });
  await clock.tick();
  stop();
  answer?.(1000);
  await new Promise((resolve) => setImmediate(resolve));
  expect(exceeded).toEqual([]);
  expect(clock.pending).toEqual([]);
});
