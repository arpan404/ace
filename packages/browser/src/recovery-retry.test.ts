import { expect, it } from "vitest";
import { TestNavigationClock } from "./navigation-test-clock.ts";
import { RecoveryRetry } from "./recovery-retry.ts";

/** The times at which each try ran, when every try fails and asks for the next. */
function failingTries(clock: TestNavigationClock, retry: RecoveryRetry, until: number): number[] {
  const at: number[] = [];
  const attempt = () => {
    at.push(clock.now());
    retry.schedule(attempt);
  };
  retry.schedule(attempt);
  clock.advance(until - clock.now());
  return at;
}

it("a browser that keeps failing to recover waits twice as long before each try, up to a minute", () => {
  const clock = new TestNavigationClock();
  const retry = new RecoveryRetry(clock);
  expect(failingTries(clock, retry, 300_000)).toEqual([
    1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000, 243_000,
  ]);
});

it("a recovery that held a minute starts the waits over; one lost sooner keeps waiting longer", () => {
  const clock = new TestNavigationClock();
  const retry = new RecoveryRetry(clock);
  let tries = 0;
  retry.schedule(() => tries++);
  clock.advance(1_000);
  retry.schedule(() => tries++);
  clock.advance(2_000);
  expect(tries).toBe(2);
  // Back, and lost again within seconds: the next wait is longer still.
  retry.recovered();
  clock.advance(5_000);
  retry.schedule(() => tries++);
  clock.advance(3_999);
  expect(tries).toBe(2);
  clock.advance(1);
  expect(tries).toBe(3);
  // Back for over a minute: a new loss is tried again after a second.
  retry.recovered();
  clock.advance(60_000);
  retry.schedule(() => tries++);
  clock.advance(1_000);
  expect(tries).toBe(4);
});

it("a closed browser tries nothing more", () => {
  const clock = new TestNavigationClock();
  const retry = new RecoveryRetry(clock);
  let tries = 0;
  retry.schedule(() => tries++);
  retry.stop();
  clock.advance(120_000);
  expect(tries).toBe(0);
});
