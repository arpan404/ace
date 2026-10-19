import { afterEach, expect, test, vi } from "vitest";
import { scheduleIdleWork, whenIdle, type IdleScheduler } from "./idle.ts";

const toTimerId = (id: number) => id as unknown as ReturnType<typeof setTimeout>;
const fromTimerId = (id: ReturnType<typeof setTimeout>) => id as unknown as number;

/** A scheduler whose idle callbacks and timers only fire when the test fires them. */
function manualScheduler(withIdle: boolean) {
  const idle = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const idleTimeouts: number[] = [];
  const timerDelays: number[] = [];
  let next = 1;
  const scheduler: IdleScheduler = {
    ...(withIdle
      ? {
          requestIdleCallback: (work: () => void, options?: { timeout: number }) => {
            if (options) idleTimeouts.push(options.timeout);
            const id = next++;
            idle.set(id, work);
            return id;
          },
          cancelIdle: (id: number) => void idle.delete(id),
        }
      : {}),
    setTimeout: (work: () => void, ms: number) => {
      timerDelays.push(ms);
      const id = next++;
      timers.set(id, work);
      return toTimerId(id);
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void timers.delete(fromTimerId(id)),
  };
  return {
    scheduler,
    fireIdle: (id = 1) => idle.get(id)?.(),
    fireTimers: () => {
      const runs = [...timers.values()];
      timers.clear();
      for (const run of runs) run();
    },
    get pendingIdle() {
      return idle.size;
    },
    get pendingTimers() {
      return timers.size;
    },
    idleTimeouts,
    timerDelays,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("idle work runs once when the page goes idle", () => {
  const clock = manualScheduler(true);
  const work = vi.fn();
  const cancel = scheduleIdleWork(clock.scheduler, work, 2_000, 2_000);
  expect(work).not.toHaveBeenCalled();
  // The idle wait is bounded, and the safety net is armed alongside it.
  expect(clock.idleTimeouts).toEqual([2_000]);
  expect(clock.timerDelays).toEqual([2_000]);
  clock.fireIdle();
  expect(work).toHaveBeenCalledTimes(1);
  // The idle callback won: its safety net is gone.
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
  cancel();
});

test("the safety net runs the work once when idle never comes", () => {
  const clock = manualScheduler(true);
  const work = vi.fn();
  scheduleIdleWork(clock.scheduler, work, 2_000, 2_000);
  // Idle never fires (a busy main thread, or a browser whose idle/rAF
  // callbacks never fire): the timeout still runs the work, exactly once.
  clock.fireTimers();
  expect(work).toHaveBeenCalledTimes(1);
  clock.fireIdle();
  expect(work).toHaveBeenCalledTimes(1);
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

test("an idle win leaves no safety net behind to double-run", () => {
  const clock = manualScheduler(true);
  const work = vi.fn();
  scheduleIdleWork(clock.scheduler, work, 2_000, 2_000);
  clock.fireIdle();
  clock.fireTimers();
  expect(work).toHaveBeenCalledTimes(1);
});

test("cancelled idle work never runs, idle or timeout", () => {
  const clock = manualScheduler(true);
  const work = vi.fn();
  const cancel = scheduleIdleWork(clock.scheduler, work, 2_000, 2_000);
  cancel();
  clock.fireIdle();
  clock.fireTimers();
  expect(work).not.toHaveBeenCalled();
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

test("without an idle callback the work waits the no-idle delay", () => {
  const clock = manualScheduler(false);
  const work = vi.fn();
  scheduleIdleWork(clock.scheduler, work, 2_000, 1_200);
  expect(clock.idleTimeouts).toEqual([]);
  expect(clock.timerDelays).toEqual([1_200]);
  clock.fireTimers();
  expect(work).toHaveBeenCalledTimes(1);
});

test("whenIdle bounds the idle wait and still runs when idle never comes", () => {
  vi.useFakeTimers();
  const idle = new Map<number, () => void>();
  const seenOptions: ({ timeout: number } | undefined)[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void, options?: { timeout: number }) => {
    seenOptions.push(options);
    const id = 1;
    idle.set(id, callback);
    return id;
  });
  const cancelled: number[] = [];
  vi.stubGlobal("cancelIdleCallback", (id: number) => void cancelled.push(id));
  const task = vi.fn();
  const cancel = whenIdle(task, 2_000);
  expect(task).not.toHaveBeenCalled();
  expect(seenOptions).toEqual([{ timeout: 2_000 }]);
  // Idle never comes: the safety net still runs the task, exactly once.
  vi.advanceTimersByTime(2_000);
  expect(task).toHaveBeenCalledTimes(1);
  idle.get(1)?.();
  expect(task).toHaveBeenCalledTimes(1);
  // The timeout won, so it cancelled the idle callback.
  expect(cancelled).toEqual([1]);
  cancel();
});

test("whenIdle cancel stops both the idle callback and the safety net", () => {
  vi.useFakeTimers();
  const idle = new Map<number, () => void>();
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    const id = 7;
    idle.set(id, callback);
    return id;
  });
  const cancelled: number[] = [];
  vi.stubGlobal("cancelIdleCallback", (id: number) => void cancelled.push(id));
  const task = vi.fn();
  const cancel = whenIdle(task, 2_000);
  cancel();
  vi.advanceTimersByTime(10_000);
  idle.get(7)?.();
  expect(task).not.toHaveBeenCalled();
  expect(cancelled).toEqual([7]);
});

test("whenIdle falls back to a timeout where idle callbacks are missing", () => {
  vi.useFakeTimers();
  const task = vi.fn();
  const cancel = whenIdle(task, 2_000);
  expect(task).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_999);
  expect(task).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(task).toHaveBeenCalledTimes(1);
  cancel();
});
