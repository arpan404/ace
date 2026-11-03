import { expect, test } from "vitest";
import {
  createLoopMonitor,
  parseDarwinSuspendedMs,
  type LoopStall,
  type LoopSuspension,
} from "./loop-monitor.ts";

const MINUTE = 60_000;

/** A clock that only moves when the test says, with a sleep record the test controls. */
function manualClock({ knowsSleep = true } = {}) {
  let time = 0;
  let slept = 0;
  let tick: (() => void) | undefined;
  return {
    clock: {
      now: () => time,
      every(_milliseconds: number, run: () => void) {
        tick = run;
        return () => {
          tick = undefined;
        };
      },
      suspendedMs: async () => (knowsSleep ? slept : undefined),
    },
    /** The timer fires `late` milliseconds after it was due. */
    async fire(late: number) {
      time += 500 + late;
      tick?.();
      await settle();
    },
    /** The system sleeps; the clock keeps counting, as macOS's does. */
    sleep(milliseconds: number) {
      time += milliseconds;
      slept += milliseconds;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function watch(time: ReturnType<typeof manualClock>) {
  const stalls: LoopStall[] = [];
  const suspensions: LoopSuspension[] = [];
  const monitor = createLoopMonitor({
    clock: time.clock,
    onStall: (stall) => stalls.push(stall),
    onSuspend: (suspension) => suspensions.push(suspension),
  });
  return { monitor, stalls, suspensions };
}

test("a loop that runs on time reports no delay and logs nothing", async () => {
  const time = manualClock();
  const { monitor, stalls } = watch(time);
  await time.fire(3);
  await time.fire(0);
  expect(monitor.status()).toEqual({ delayMs: 0, maxDelayMs: 3, stalls: 0 });
  expect(stalls).toEqual([]);
});

test("a stall over a second is logged at once, repeats within a minute are counted but not logged", async () => {
  const time = manualClock();
  const { monitor, stalls } = watch(time);
  await time.fire(1_200);
  await time.fire(2_500);
  await time.fire(1_100);
  await time.fire(10);
  expect(stalls).toEqual([{ delayMs: 1_200, suppressed: 0 }]);
  // A watchdog reading status tells the busy loop's history from its current, recovered state.
  expect(monitor.status()).toEqual({ delayMs: 10, maxDelayMs: 2_500, stalls: 3 });
  for (let n = 0; n < 120; n++) await time.fire(0);
  await time.fire(1_500);
  expect(stalls.at(-1)).toEqual({ delayMs: 1_500, suppressed: 2 });
});

test("a 15-minute suspension isn't reported as a stall", async () => {
  const time = manualClock();
  const { monitor, stalls, suspensions } = watch(time);
  await time.fire(0);
  time.sleep(15 * MINUTE);
  await time.fire(0);
  expect(stalls).toEqual([]);
  expect(monitor.status()).toEqual({ delayMs: 0, maxDelayMs: 0, stalls: 0 });
  expect(suspensions).toEqual([{ suspendedMs: 15 * MINUTE, suppressed: 0 }]);
});

test("a 2 s stall right after wake is still reported with its true length", async () => {
  const time = manualClock();
  const { stalls } = watch(time);
  await time.fire(0);
  time.sleep(15 * MINUTE);
  await time.fire(2_000);
  expect(stalls).toEqual([{ delayMs: 2_000, suppressed: 0 }]);
});

test("DarkWake cycles through a night log one suspension line per ten minutes and no stalls", async () => {
  const time = manualClock();
  const { stalls, suspensions } = watch(time);
  // Asleep about a minute, then awake for twenty seconds, for an hour.
  for (let cycle = 0; cycle < 50; cycle++) {
    time.sleep(MINUTE);
    for (let n = 0; n < 40; n++) await time.fire(0);
  }
  expect(stalls).toEqual([]);
  expect(suspensions.length).toBeGreaterThanOrEqual(5);
  expect(suspensions.length).toBeLessThanOrEqual(7);
  expect(suspensions.at(-1)?.suppressed).toBeGreaterThan(0);
});

test("sleep is subtracted once, so a later stall keeps its full length", async () => {
  const time = manualClock();
  const { stalls } = watch(time);
  time.sleep(10 * MINUTE);
  await time.fire(0);
  for (let n = 0; n < 130; n++) await time.fire(0);
  await time.fire(1_500);
  expect(stalls).toEqual([{ delayMs: 1_500, suppressed: 0 }]);
});

test("when the system can't say whether it slept, a late tick is reported as before", async () => {
  const time = manualClock({ knowsSleep: false });
  const { stalls } = watch(time);
  await time.fire(1_300);
  expect(stalls).toEqual([{ delayMs: 1_300, suppressed: 0 }]);
});

test("macOS sleep is the monotonic clock's lead over mach_absolute_time", () => {
  // 24 MHz timebase as on Apple silicon: 100 s awake, monotonic shows 160 s, so 60 s asleep.
  const before = parseDarwinSuspendedMs("1000000000 2400000000\n24000000\n");
  const after = parseDarwinSuspendedMs("1160000000 4800000000\n24000000\n");
  expect(before).toBeDefined();
  expect((after ?? 0) - (before ?? 0)).toBeCloseTo(60_000);
  expect(parseDarwinSuspendedMs("sysctl: unknown oid 'kern.monotonicclock_usecs'")).toBeUndefined();
  expect(parseDarwinSuspendedMs("")).toBeUndefined();
});
