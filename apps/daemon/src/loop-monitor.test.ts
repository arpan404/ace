import { expect, test } from "vitest";
import {
  createLoopMonitor,
  parseDarwinLastSleep,
  systemLoopClock,
  type LoopSleep,
  type LoopStall,
  type LoopSuspension,
} from "./loop-monitor.ts";

const MINUTE = 60_000;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A clock that only moves when the test says. It counts sleep, as macOS's does, and keeps the
 * kernel's record of the most recent sleep. `hold()` makes the next sleep read wait for `release`.
 */
function manualClock({ knowsSleep = true } = {}) {
  let time = 0;
  let last: LoopSleep | undefined;
  let tick: (() => void) | undefined;
  let held: Array<() => void> = [];
  let holding = false;
  let failing = false;
  const reads = { started: 0, aborted: 0 };
  // The record is read when the read finishes, so a later sleep replaces an earlier one.
  const answer = () => (knowsSleep ? last : undefined);
  const clock = {
    now: () => time,
    every(_milliseconds: number, run: () => void) {
      tick = run;
      return () => {
        tick = undefined;
      };
    },
    lastSleep(signal: AbortSignal): Promise<LoopSleep | undefined> {
      reads.started++;
      signal.addEventListener("abort", () => reads.aborted++, { once: true });
      if (failing) return Promise.reject(new Error("sysctl failed"));
      if (!holding) return Promise.resolve(answer());
      return new Promise((resolve) => held.push(() => resolve(answer())));
    },
  };
  return {
    clock,
    reads,
    /** The timer fires `late` milliseconds after it was due. */
    async fire(late: number) {
      time += 500 + late;
      tick?.();
      await settle();
    },
    sleep(milliseconds: number) {
      last = { from: time, to: time + milliseconds };
      time += milliseconds;
    },
    hold() {
      holding = true;
    },
    async release() {
      holding = false;
      const pending = held;
      held = [];
      for (const resolve of pending) resolve();
      await settle();
    },
    failReads(fail: boolean) {
      failing = fail;
    },
  };
}

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

test("a sub-second sleep earlier doesn't shorten a later stall", async () => {
  const time = manualClock();
  const { stalls } = watch(time);
  await time.fire(0);
  time.sleep(800);
  await time.fire(0);
  for (let n = 0; n < 10; n++) await time.fire(0);
  await time.fire(1_500);
  expect(stalls).toEqual([{ delayMs: 1_500, suppressed: 0 }]);
});

test("a failed sleep read reports the late tick in full and leaves nothing to erase a later stall", async () => {
  const time = manualClock();
  const { stalls } = watch(time);
  await time.fire(0);
  time.sleep(10 * MINUTE);
  time.failReads(true);
  await time.fire(0);
  time.failReads(false);
  expect(stalls).toEqual([{ delayMs: 10 * MINUTE, suppressed: 0 }]);
  for (let n = 0; n < 130; n++) await time.fire(0);
  await time.fire(1_500);
  expect(stalls.at(-1)).toEqual({ delayMs: 1_500, suppressed: 0 });
});

test("a sleep that ends after a stalled tick doesn't erase it while its read is queued", async () => {
  const time = manualClock();
  const { monitor, stalls, suspensions } = watch(time);
  await time.fire(0);
  time.hold();
  // One read is in flight for this stall when the next real stall queues behind it.
  await time.fire(1_500);
  await time.fire(2_000);
  time.sleep(MINUTE);
  await time.fire(0);
  await time.release();
  await time.release();
  expect(stalls).toEqual([{ delayMs: 1_500, suppressed: 0 }]);
  expect(monitor.status()).toEqual({ delayMs: 0, maxDelayMs: 2_000, stalls: 2 });
  expect(suspensions).toEqual([{ suspendedMs: MINUTE, suppressed: 0 }]);
});

test("late ticks during a sleep read share one follow-up read, and closing cancels it", async () => {
  const time = manualClock();
  const { monitor, stalls } = watch(time);
  time.hold();
  await time.fire(1_200);
  for (let n = 0; n < 5; n++) await time.fire(1_100);
  expect(time.reads.started).toBe(1);
  await time.release();
  expect(time.reads.started).toBe(2);
  expect(monitor.status().stalls).toBe(6);
  // A read is running for this stall and another stall waits behind it when the daemon stops.
  time.hold();
  await time.fire(1_300);
  await time.fire(1_100);
  monitor.close();
  await time.release();
  expect(time.reads.aborted).toBeGreaterThan(0);
  expect(time.reads.started).toBe(3);
  expect(monitor.status().stalls).toBe(6);
  expect(stalls).toHaveLength(1);
});

test("on Linux and Windows a late tick is reported in full", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const time = manualClock();
    const stalls: LoopStall[] = [];
    createLoopMonitor({
      clock: { ...time.clock, lastSleep: systemLoopClock(platform).lastSleep },
      onStall: (stall) => stalls.push(stall),
    });
    await time.fire(0);
    time.sleep(MINUTE);
    await time.fire(0);
    expect(stalls).toEqual([{ delayMs: MINUTE, suppressed: 0 }]);
  }
});

test("macOS's last sleep and wake times land on the loop clock's timeline", () => {
  const output =
    "{ sec = 1793662224, usec = 485978 } Mon Nov  2 17:30:24 2026\n" +
    "{ sec = 1793662543, usec = 778348 } Mon Nov  2 17:35:43 2026\n";
  // The loop clock reads 1,000 ms when the wall clock reads 1793662600000 ms.
  const sleep = parseDarwinLastSleep(output, 1_793_662_600_000 - 1_000);
  expect(sleep?.from).toBeCloseTo(1_000 - (1_793_662_600_000 - 1_793_662_224_485.978));
  expect(sleep?.to).toBeCloseTo(1_000 - (1_793_662_600_000 - 1_793_662_543_778.348));
  expect(parseDarwinLastSleep("sysctl: unknown oid 'kern.sleeptime'", 0)).toBeUndefined();
  // Never slept since boot.
  expect(
    parseDarwinLastSleep("{ sec = 0, usec = 0 } Thu Jan 1\n{ sec = 0, usec = 0 } Thu Jan 1\n", 0),
  ).toBeUndefined();
});
