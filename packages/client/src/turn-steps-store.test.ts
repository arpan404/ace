import { beforeAll, expect, test } from "vitest";
import { TurnStepsCache } from "./turn-steps.ts";
import {
  daemon,
  failingDaemon,
  memoryStore,
  settle,
  silentDaemon,
  step,
} from "./turn-steps.fixture.ts";

/*
 * Finished turns kept between sessions: a later session (a new cache over the same store) shows
 * what an earlier one read before the daemon answers, and never trusts what it can't check.
 */

// The record's schema loads on the first record; warm it so each read below settles in a tick.
beforeAll(() => import("./turn-steps-record.ts"));

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    threadId: "t",
    ordinal: 1,
    endSeq: 10,
    more: false,
    cursor: null,
    steps: [step("kept-1", 1), step("kept-2", 2)],
    ...overrides,
  };
}

// Mutation: waiting for the daemon although the store holds the turn as it is now.
test("a kept turn as new as its summary shows at once, and the daemon's read is ended", async () => {
  const store = memoryStore();
  await store.set("t/1", record());
  const silent = silentDaemon();
  const cache = new TurnStepsCache({ read: silent.read, store });
  const release = cache.retain("t", 1, 10);
  await settle();
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", endSeq: 10, more: false });
  expect(cache.get("t", 1)?.steps.map((kept) => kept.item.id)).toEqual(["kept-1", "kept-2"]);
  expect(silent.reads[0]?.signal?.aborted).toBe(true);
  release();
});

// Mutation: taking a kept turn as current after the turn went on.
test("a kept turn older than its summary shows while the daemon's read replaces it", async () => {
  const store = memoryStore();
  await store.set("t/1", record({ endSeq: 8 }));
  let answer: (() => void) | undefined;
  const d = daemon(() => 3, 12);
  const cache = new TurnStepsCache({
    read: (input) =>
      new Promise((resolve) => {
        answer = () => resolve(d.read(input));
      }),
    store,
  });
  const release = cache.retain("t", 1, 12);
  await settle();
  expect(cache.get("t", 1)?.state).toBe("loading");
  expect(cache.get("t", 1)?.steps.map((kept) => kept.item.id)).toEqual(["kept-1", "kept-2"]);
  answer?.();
  await settle();
  expect(cache.get("t", 1)).toMatchObject({ state: "ready", endSeq: 12 });
  expect(cache.get("t", 1)?.steps.map((read) => read.item.id)).toEqual(["1-1", "1-2", "1-3"]);
  release();
});

// Mutation: a later session finding nothing an earlier one read.
test("a turn read in one session shows at once in the next", async () => {
  const store = memoryStore();
  const first = new TurnStepsCache({ read: daemon(() => 3).read, store });
  first.retain("t", 1, 10)();
  await settle();
  const next = new TurnStepsCache({ read: silentDaemon().read, store });
  const release = next.retain("t", 1, 10);
  await settle();
  expect(next.get("t", 1)?.state).toBe("ready");
  expect(next.get("t", 1)?.steps.map((read) => read.item.id)).toEqual(["1-1", "1-2", "1-3"]);
  release();
});

// Mutation: trusting whatever the store hands back.
test.each([
  ["another version", record({ version: 2 })],
  ["another turn", record({ ordinal: 2 })],
  ["another thread", record({ threadId: "u" })],
  ["steps that aren't steps", record({ steps: [{ seq: 1 }] })],
  ["a cursor that disagrees with more", record({ cursor: 4 })],
  ["not a record at all", "steps"],
])("a kept record of %s is ignored", async (_, value) => {
  const store = memoryStore();
  await store.set("t/1", value);
  const cache = new TurnStepsCache({ read: silentDaemon().read, store });
  const release = cache.retain("t", 1);
  await settle();
  expect(cache.get("t", 1)).toMatchObject({ state: "loading", steps: [] });
  release();
});

// Mutation: keeping a read that failed.
test("a failed read is never kept", async () => {
  const store = memoryStore();
  const cache = new TurnStepsCache({ read: failingDaemon().read, store });
  const release = cache.retain("t", 1, 10);
  await settle();
  expect(cache.get("t", 1)?.state).toBe("failed");
  expect(store.records.size).toBe(0);
  release();
});

// Mutation: the store's late answer overwriting what the daemon just said.
test("a kept record arriving after the daemon's answer changes nothing", async () => {
  let answer: ((value: unknown) => void) | undefined;
  const store = {
    get: () => new Promise((resolve) => (answer = resolve)),
    set: async () => {},
  };
  const cache = new TurnStepsCache({ read: daemon(() => 3, 12).read, store });
  const release = cache.retain("t", 1, 12);
  await settle();
  answer?.(record({ endSeq: 12 }));
  await settle();
  expect(cache.get("t", 1)?.steps.map((read) => read.item.id)).toEqual(["1-1", "1-2", "1-3"]);
  release();
});
