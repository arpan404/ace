import { expect, it } from "vitest";
import { NavigationTask } from "./navigation.ts";
import { NavigationPolicies } from "./policy-waits.ts";

/** A monotonic clock whose timers fire only when the test advances it. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ at: number; work: () => void }>();
  return {
    now: () => now,
    set(delay: number, work: () => void) {
      const timer = { at: now + delay, work };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          timer.work();
        }
    },
  };
}

it("a navigation in flight when the computer wakes gets its time again instead of failing", () => {
  const clock = manualClock();
  const policies = new NavigationPolicies();
  const task = new NavigationTask(false, 10_000, clock);
  policies.start(task);
  clock.advance(9_000);
  policies.wake();
  clock.advance(9_000);
  expect(task.signal.aborted).toBe(false);
  clock.advance(2_000);
  expect(task.deadlineExpired).toBe(true);
  policies.finish(task);
  task.close();
});
