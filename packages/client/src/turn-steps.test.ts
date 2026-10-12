import { Item, TurnStepsResponse } from "@ace/protocol";
import { expect, test } from "vitest";
import { TurnStepsCache } from "./turn-steps.ts";

function step(id: string, seq: number) {
  return {
    seq,
    item: Item.parse({
      id,
      agentId: "root",
      type: "reasoning",
      text: id,
      complete: true,
      createdAt: 1,
    }),
  };
}

/** A daemon whose turns hold `size` steps each, read in pages of up to 200. */
function daemon(size: (ordinal: number) => number, endSeq = 10) {
  const reads: { ordinal: number; after: number | undefined }[] = [];
  return {
    reads,
    endSeq,
    read: async (input: {
      turnOrdinal: number;
      after?: number | undefined;
      limit?: number | undefined;
    }): Promise<TurnStepsResponse> => {
      reads.push({ ordinal: input.turnOrdinal, after: input.after });
      const from = input.after ?? 0;
      const total = size(input.turnOrdinal);
      const count = Math.min(input.limit ?? 100, total - from);
      return TurnStepsResponse.parse({
        type: "turn.steps",
        requestId: "r",
        threadId: "t",
        turnOrdinal: input.turnOrdinal,
        seq: 99,
        endSeq,
        steps: Array.from({ length: count }, (_, index) =>
          step(`${input.turnOrdinal}-${from + index + 1}`, from + index + 1),
        ),
        after: from + count < total ? from + count : null,
      });
    },
  };
}

function timers() {
  const pending: { run: () => void; cancelled: boolean }[] = [];
  return {
    schedule(run: () => void) {
      const timer = { run, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire() {
      for (const timer of pending.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

// Mutation: keeping a released turn forever.
test("a turn released and not shown again is dropped after the grace period", async () => {
  const d = daemon(() => 3);
  const clock = timers();
  const cache = new TurnStepsCache({ read: d.read, schedule: clock.schedule });
  const release = cache.retain("t", 1);
  await settle();
  release();
  expect(cache.get("t", 1)?.steps).toHaveLength(3);
  clock.fire();
  expect(cache.get("t", 1)).toBeUndefined();
});

test("a turn shown again within the grace period is not read again", async () => {
  const d = daemon(() => 3);
  const clock = timers();
  const cache = new TurnStepsCache({ read: d.read, schedule: clock.schedule });
  cache.retain("t", 1)();
  await settle();
  const again = cache.retain("t", 1);
  clock.fire();
  expect(cache.get("t", 1)?.state).toBe("ready");
  expect(d.reads).toHaveLength(1);
  again();
});

// Mutation: letting unretained turns grow without bound.
test("released turns together never hold more than the step budget; shown ones stay", async () => {
  const d = daemon(() => 40);
  const cache = new TurnStepsCache({ read: d.read, maxSteps: 100, schedule: () => () => {} });
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

test("closing a thread drops its turns", async () => {
  const d = daemon(() => 2);
  const cache = new TurnStepsCache({ read: d.read });
  cache.retain("t", 1);
  await settle();
  cache.dropThread("t");
  expect(cache.get("t", 1)).toBeUndefined();
});
