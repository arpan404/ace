import { expect, it } from "vitest";
import { watchWake } from "./wake-watch.ts";

/** Wall and monotonic clocks the test moves, and one timer queue on the monotonic clock. */
function clocks() {
  let wall = 1_000_000;
  let monotonic = 0;
  const timers = new Set<{ at: number; work: () => void }>();
  return {
    wall: () => wall,
    monotonic: () => monotonic,
    set(delay: number, work: () => void) {
      const timer = { at: monotonic + delay, work };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    /** Time passes awake: both clocks move. */
    awake(milliseconds: number) {
      wall += milliseconds;
      monotonic += milliseconds;
      for (const timer of timers)
        if (timer.at <= monotonic) {
          timers.delete(timer);
          timer.work();
        }
    },
    /** The machine sleeps: only the wall clock moves. */
    sleep(milliseconds: number) {
      wall += milliseconds;
    },
  };
}

it("a sleep is noticed at the next check after waking, and ordinary time passing is not", () => {
  const clock = clocks();
  let wakes = 0;
  const stop = watchWake(clock, { every: 10_000, toleranceMs: 30_000, set: clock.set }, () => {
    wakes++;
  });
  clock.awake(60_000);
  expect(wakes).toBe(0);
  clock.sleep(2 * 60 * 60_000);
  expect(wakes).toBe(0);
  clock.awake(10_000);
  expect(wakes).toBe(1);
  clock.awake(60_000);
  expect(wakes).toBe(1);
  stop();
  clock.sleep(60 * 60_000);
  clock.awake(60_000);
  expect(wakes).toBe(1);
});
