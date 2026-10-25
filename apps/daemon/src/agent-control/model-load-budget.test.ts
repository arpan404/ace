import { expect, test } from "vitest";
import { ManualClock } from "../engine/test-support.ts";
import { modelLoadBudget } from "./model-load-budget.ts";

const never = new Promise<never>(() => {});
/** Lets settled promises run their callbacks, without moving the injected clock. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function watch(wait: Promise<boolean>) {
  const seen: { value?: boolean; error?: unknown } = {};
  wait.then(
    (value) => (seen.value = value),
    (error: unknown) => (seen.error = error),
  );
  return seen;
}

test("every wait in one operation ends at one twenty-second deadline from when it began", async () => {
  const clock = new ManualClock();
  const started = clock.now();
  const budget = modelLoadBudget(clock);
  // Startup readiness takes most of the budget; loading the model lists gets only what is left.
  const readiness = watch(budget.wait(never));
  clock.advance(started + 15_000);
  const loading = watch(budget.wait(never));
  clock.advance(started + 19_999);
  await turn();
  expect([readiness, loading]).toEqual([{}, {}]);
  clock.advance(started + 20_000);
  await turn();
  expect([readiness, loading]).toEqual([{ value: false }, { value: false }]);
  // Once spent, a later step does not wait at all.
  expect(await budget.wait(never)).toBe(false);
});

test("work that finishes in time is reported as finished, and its failure comes through", async () => {
  const budget = modelLoadBudget(new ManualClock());
  expect(await budget.wait(Promise.resolve())).toBe(true);
  await expect(budget.wait(Promise.reject(new Error("catalog closed")))).rejects.toThrow(
    "catalog closed",
  );
});

test("cancelling the operation ends its wait at once with the cancellation", async () => {
  const abort = new AbortController();
  const budget = modelLoadBudget(new ManualClock(), abort.signal);
  const waiting = budget.wait(never);
  abort.abort(new Error("caller left"));
  await expect(waiting).rejects.toThrow("caller left");
  await expect(budget.wait(Promise.resolve())).rejects.toThrow("caller left");
});

test("work that outlives its call keeps the call's deadline but not its cancellation", async () => {
  const clock = new ManualClock();
  const started = clock.now();
  const abort = new AbortController();
  const detached = modelLoadBudget(clock, abort.signal).detached();
  const waiting = watch(detached.wait(never));
  abort.abort();
  await turn();
  expect(waiting).toEqual({});
  clock.advance(started + 20_000);
  await turn();
  expect(waiting).toEqual({ value: false });
});

test("an ended budget stops its timer, while one still running expires", async () => {
  const clock = new ManualClock();
  const ended = modelLoadBudget(clock);
  const running = modelLoadBudget(clock);
  const afterEnd = watch(ended.wait(never));
  const stillRunning = watch(running.wait(never));
  ended.end();
  clock.advance(clock.now() + 20_000);
  await turn();
  expect(afterEnd).toEqual({});
  expect(stillRunning).toEqual({ value: false });
});

test("a wait on an already cancelled operation still owns the failure of the work it was given", async () => {
  const abort = new AbortController();
  abort.abort(new Error("caller left"));
  const budget = modelLoadBudget(new ManualClock(), abort.signal);
  // Vitest fails the run on an unhandled rejection, so the catalog's failure must be handled.
  await expect(budget.wait(Promise.reject(new Error("catalog closed")))).rejects.toThrow(
    "caller left",
  );
  await turn();
});

test("work that outlives its call keeps the deadline running after the call ends, until it ends too", async () => {
  const clock = new ManualClock();
  const started = clock.now();
  const call = modelLoadBudget(clock);
  const creation = call.detached();
  const waiting = watch(creation.wait(never));
  // The call returns and lets go; the creation it started is still waiting.
  call.end();
  clock.advance(started + 20_000);
  await turn();
  expect(waiting).toEqual({ value: false });

  // Once both have let go, the timer is gone: nothing is left waiting on it.
  const other = modelLoadBudget(clock);
  const otherCreation = other.detached();
  const late = watch(otherCreation.wait(never));
  other.end();
  otherCreation.end();
  // Ending twice is one ending, not one for another holder.
  other.end();
  clock.advance(clock.now() + 20_000);
  await turn();
  expect(late).toEqual({});
});
