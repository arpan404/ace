import { expect, test } from "vitest";
import { guardedTick } from "./inventory-retry.ts";

/** A tick on a clock the test moves, around a step whose outcomes the test lists. */
function setup(outcomes: (boolean | Error)[]) {
  let now = 0;
  let calls = 0;
  const reported: unknown[] = [];
  let stopped = false;
  const tick = guardedTick(
    () => {
      calls++;
      const outcome = outcomes.shift() ?? true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    { now: () => now, report: (error) => reported.push(error), stop: () => (stopped = true) },
  );
  return {
    at(ms: number) {
      now = ms;
      tick();
    },
    get calls() {
      return calls;
    },
    reported,
    get stopped() {
      return stopped;
    },
  };
}

test("a recorder tick whose write fails never throws, backs off, and records again once it can", () => {
  const full = Object.assign(new Error("database or disk is full"), { errcode: 13 });
  const state = setup([full, full, true]);
  expect(() => state.at(0)).not.toThrow();
  expect(state.reported).toEqual([full]);
  // One second's wait after the first failure: the next tick inside it does nothing.
  state.at(500);
  expect(state.calls).toBe(1);
  state.at(1_000);
  expect(state.calls).toBe(2);
  // Two seconds after the second.
  state.at(2_999);
  expect(state.calls).toBe(2);
  state.at(3_000);
  expect(state.calls).toBe(3);
  // A success clears the backoff: the next tick runs at once.
  state.at(3_001);
  expect(state.calls).toBe(4);
  expect(state.stopped).toBe(false);
});

test("the backoff after repeated failures stops growing at 30 seconds", () => {
  const state = setup(Array.from({ length: 12 }, () => new Error("busy")));
  let at = 0;
  for (let failure = 0; failure < 10; failure++) {
    state.at(at);
    at += 30_000;
  }
  expect(state.calls).toBe(10);
});

test("a recorder with nothing left to record stops", () => {
  const state = setup([false]);
  state.at(0);
  expect(state.stopped).toBe(true);
});
