import { expect, test } from "vitest";
import { TurnStepsCache } from "./turn-steps.ts";
import { daemon, settle, silentDaemon, timers } from "./turn-steps.fixture.ts";

// Mutations: stopping after the first page, or reading again while the turn is held.
test("an opened turn reads all its steps once and keeps them while shown", async () => {
  const d = daemon(() => 450);
  const cache = new TurnStepsCache({ read: d.read });
  const release = cache.retain("t", 1);
  expect(cache.get("t", 1)?.state).toBe("loading");
  await settle();
  const entry = cache.get("t", 1);
  expect(entry?.state).toBe("ready");
  expect(entry?.steps).toHaveLength(450);
  expect(entry?.steps.at(-1)?.item.id).toBe("1-450");
  expect(d.reads.map((read) => read.after)).toEqual([undefined, 200, 400]);
  cache.retain("t", 1)();
  expect(d.reads).toHaveLength(3);
  release();
});

// Mutation: dropping a read turn on a timer once it is released.
test("a released turn shows again without a new read, however long it was away", async () => {
  const d = daemon(() => 3);
  const clock = timers();
  const cache = new TurnStepsCache({ read: d.read, schedule: clock.schedule });
  cache.retain("t", 1)();
  await settle();
  clock.fire();
  const again = cache.retain("t", 1);
  expect(cache.get("t", 1)?.state).toBe("ready");
  expect(cache.get("t", 1)?.steps).toHaveLength(3);
  expect(d.reads).toHaveLength(1);
  again();
});

// Mutation: closing a thread forgetting the steps it read.
test("a turn of a thread closed and opened again shows its steps at once, with no read", async () => {
  const d = daemon(() => 3);
  // After the first read the daemon goes quiet: whatever shows next can't have come from it.
  const silent = silentDaemon();
  let answering = true;
  const cache = new TurnStepsCache({
    read: (input, options) => (answering ? d.read(input) : silent.read(input, options)),
  });
  cache.retain("t", 1);
  await settle();
  cache.dropThread("t");
  answering = false;
  const release = cache.retain("t", 1);
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", more: false });
  expect(cache.get("t", 1)?.steps.map((step) => step.item.id)).toEqual(["1-1", "1-2", "1-3"]);
  expect(silent.reads).toHaveLength(0);
  release();
});

// Mutation: a closed thread's read left running, or left loading forever.
test("closing a thread ends its reads in flight; opening it again reads afresh", async () => {
  const silent = silentDaemon();
  const cache = new TurnStepsCache({ read: silent.read });
  cache.retain("t", 1);
  cache.dropThread("t");
  expect(silent.reads[0]?.signal?.aborted).toBe(true);
  expect(cache.get("t", 1)).toBeUndefined();
  cache.retain("t", 1);
  expect(silent.reads).toHaveLength(2);
  expect(cache.get("t", 1)?.state).toBe("loading");
});

// Mutation: letting unretained turns grow without bound.
test("released turns together never hold more than the step budget; shown ones stay", async () => {
  const d = daemon(() => 40);
  const cache = new TurnStepsCache({ read: d.read, maxSteps: 100 });
  const shown = cache.retain("t", 1);
  for (const ordinal of [2, 3, 4]) {
    const release = cache.retain("t", ordinal);
    await settle();
    release();
  }
  expect(cache.get("t", 1)?.steps).toHaveLength(40);
  // 2 is the oldest released turn: it went to keep 3 and 4 within 100 steps.
  expect(cache.get("t", 2)).toBeUndefined();
  expect(cache.get("t", 3)?.steps).toHaveLength(40);
  expect(cache.get("t", 4)?.steps).toHaveLength(40);
  shown();
});

// Mutation: counting only steps, so many small (or empty) turns pile up.
test("released turns never number more than the turn budget, oldest use going first", async () => {
  const d = daemon(() => 1);
  const cache = new TurnStepsCache({ read: d.read, maxTurns: 3 });
  for (const ordinal of [1, 2, 3, 4, 5]) {
    const release = cache.retain("t", ordinal);
    await settle();
    release();
    // Showing 1 again keeps it among the newest.
    cache.get("t", 1);
  }
  const kept = [1, 2, 3, 4, 5].filter((ordinal) => cache.get("t", ordinal));
  expect(kept).toEqual([1, 4, 5]);
});

// Mutation: closing a thread leaving its turns outside the budget.
test("a closed thread's turns count against the budget", async () => {
  const d = daemon(() => 60);
  const cache = new TurnStepsCache({ read: d.read, maxSteps: 100 });
  cache.retain("a", 1);
  cache.retain("b", 1);
  await settle();
  cache.dropThread("a");
  cache.dropThread("b");
  expect(cache.get("a", 1)).toBeUndefined();
  expect(cache.get("b", 1)?.steps).toHaveLength(60);
});

// Mutation: serving a turn's old steps after it changed.
test("a turn whose summary moved past the read is read again", async () => {
  const d = daemon(() => 2, 10);
  const cache = new TurnStepsCache({ read: d.read });
  cache.retain("t", 1, 10)();
  await settle();
  cache.retain("t", 1, 10)();
  expect(d.reads).toHaveLength(1);
  cache.retain("t", 1, 12)();
  await settle();
  expect(d.reads).toHaveLength(2);
});

// Mutation: a slot read again inheriting holds its old releases never take back.
test("a turn read again while shown leaves the budget's protection once nothing shows it", async () => {
  const d = daemon(() => 2, 10);
  const cache = new TurnStepsCache({ read: d.read, maxTurns: 1 });
  const first = cache.retain("t", 1, 10);
  await settle();
  // The turn changed while shown: a second viewer's summary makes it read again.
  const second = cache.retain("t", 1, 12);
  await settle();
  first();
  second();
  cache.retain("t", 2)();
  await settle();
  expect(cache.get("t", 1)).toBeUndefined();
  expect(cache.get("t", 2)?.state).toBe("ready");
});

// Mutation: a long turn stopping for good at the first read's cap.
test("a turn longer than one read says so and reads on when asked", async () => {
  const d = daemon(() => 450);
  const cache = new TurnStepsCache({ read: d.read, maxTurnSteps: 200 });
  const release = cache.retain("t", 1);
  await settle();
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", more: true });
  expect(cache.get("t", 1)?.steps).toHaveLength(200);
  cache.loadMore("t", 1);
  await settle();
  expect(cache.get("t", 1)?.steps).toHaveLength(400);
  cache.loadMore("t", 1);
  await settle();
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", more: false });
  expect(cache.get("t", 1)?.steps.at(-1)?.item.id).toBe("1-450");
  release();
});

// Mutation: a release from before the thread was dropped taking the new view's hold.
test("a turn shown again after its thread was dropped stays held, whatever the old view releases", async () => {
  const d = daemon(() => 2);
  const cache = new TurnStepsCache({ read: d.read, maxTurns: 0 });
  const old = cache.retain("t", 1);
  await settle();
  cache.dropThread("t");
  const shown = cache.retain("t", 1);
  await settle();
  old();
  expect(cache.get("t", 1)?.state).toBe("ready");
  shown();
  expect(cache.get("t", 1)).toBeUndefined();
});

// Mutation: warming that waits for the open, or holds the turn forever.
test("a turn about to open is read before it opens, and held only a while", async () => {
  const d = daemon(() => 3);
  const clock = timers();
  const cache = new TurnStepsCache({ read: d.read, schedule: clock.schedule, maxTurns: 0 });
  cache.warm("t", 1, 10);
  await settle();
  expect(d.reads).toHaveLength(1);
  expect(cache.get("t", 1)?.state).toBe("ready");
  clock.fire();
  expect(cache.get("t", 1)).toBeUndefined();
});

// Mutation: closing a thread while it reads on losing the part already read.
test("closing a thread while a long turn reads on keeps the part already read", async () => {
  const d = daemon(() => 450);
  const silent = silentDaemon();
  let answering = true;
  const cache = new TurnStepsCache({
    read: (input, options) => (answering ? d.read(input) : silent.read(input, options)),
    maxTurnSteps: 200,
  });
  cache.retain("t", 1);
  await settle();
  answering = false;
  cache.loadMore("t", 1);
  expect(cache.get("t", 1)?.state).toBe("loading");
  cache.dropThread("t");
  expect(silent.reads[0]?.signal?.aborted).toBe(true);
  const release = cache.retain("t", 1);
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", more: true });
  expect(cache.get("t", 1)?.steps).toHaveLength(200);
  answering = true;
  cache.loadMore("t", 1);
  await settle();
  expect(cache.get("t", 1)?.steps.at(-1)?.item.id).toBe("1-400");
  release();
});
