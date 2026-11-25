// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the actor's creation, capacity and rollback rules. Switch on, addon built with `engine-probe`. Each case names the (a)
 * file that will show it and is deleted when that file passes with the switch on.
 */

import type { ThreadId } from "@ace/protocol";
import { describe, expect, test } from "vitest";

import {
  bareSeam,
  errors,
  frame,
  holdWrites,
  native,
  seamWithSession,
  tick,
  track,
  translator,
} from "./actor-support.ts";
const thread = (id: string): ThreadId => id as ThreadId;

async function rollbackStaged(): Promise<void> {
  const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 4 } });
  try {
    const hold = holdWrites(seam.store);
    for (let index = 0; index < 3; index += 1) {
      void session.context.onFrame(frame(index));
      seam.probe.seal("t1");
    }
    const paused = session.context.outputFlow.paused();
    expect(() =>
      seam.store.atomic(() => {
        for (let index = 0; index < 5; index += 1) seam.probe.enqueue("t1", `op-${index}`);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(session.aborted()).toBe(0);
    expect(session.context.outputFlow.paused()).toBe(paused);
    await hold.release();
    await seam.engine.flush();
    expect(session.log().enqueued).toEqual([]);
    expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 1, 1]);
  } finally {
    await seam.close();
  }
}

describe.runIf(native)("the native actor and frames", () => {
  test("an actor created inside a rolled-back transaction is discarded and never polled", async () => {
    const seam = await bareSeam();
    try {
      seam.probe.useDeps("t1");
      await tick();
      const pollsBefore = (await seam.probe.turns()).turns.reduce((sum, polls) => sum + polls, 0);
      expect(() =>
        seam.store.atomic(() => {
          seam.engine.rootAgent(thread("a"));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(seam.engine.liveThreadIds()).toEqual([]);
      expect(seam.probe.registeredWakers()).toBe(0);
      // No task was spawned for the rolled-back actor, so no poll was added.
      const after = (await seam.probe.turns()).turns;
      expect(after.reduce((sum, polls) => sum + polls, 0)).toBe(pollsBefore);
      seam.store.atomic(() => {
        seam.engine.rootAgent(thread("b"));
      });
      await tick();
      expect(seam.engine.liveThreadIds()).toEqual(["b"]);
      expect(seam.probe.registeredWakers()).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("an actor created at capacity inside a transaction returns what TypeScript returns, and a rollback evicts nobody", async () => {
    // (i) rollback
    const first = await bareSeam({ limits: { maxActiveThreads: 2 } });
    first.probe.useDeps("t1");
    try {
      first.engine.rootAgent(thread("a"));
      first.engine.rootAgent(thread("b"));
      expect(() =>
        first.store.atomic(() => {
          first.engine.rootAgent(thread("c"));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      await tick();
      expect(first.engine.liveThreadIds()).toEqual(["a", "b"]);
    } finally {
      await first.close();
    }
    // (ii) commit evicts the oldest, exactly where TypeScript does.
    const second = await bareSeam({ limits: { maxActiveThreads: 2 } });
    second.probe.useDeps("t1");
    try {
      second.engine.rootAgent(thread("a"));
      second.engine.rootAgent(thread("b"));
      second.store.atomic(() => {
        second.engine.rootAgent(thread("c"));
      });
      await tick();
      expect(second.engine.liveThreadIds()).toEqual(["b", "c"]);
    } finally {
      await second.close();
    }
    // (iii) two creations pledge two different victims; a third throws at the call.
    const third = await bareSeam({ limits: { maxActiveThreads: 2 } });
    third.probe.useDeps("t1");
    try {
      third.engine.rootAgent(thread("a"));
      third.engine.rootAgent(thread("b"));
      third.store.atomic(() => {
        third.engine.rootAgent(thread("c1"));
        third.engine.rootAgent(thread("c2"));
        expect(() => third.engine.rootAgent(thread("c3"))).toThrow(
          "Engine actor capacity exceeded",
        );
      });
      await tick();
      expect(third.engine.liveThreadIds().toSorted()).toEqual(["c1", "c2"]);
    } finally {
      await third.close();
    }
  });

  test("staged enqueues of a rolled-back transaction never overflow the mailbox", async () => {
    await rollbackStaged();
    const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 4 } });
    try {
      const hold = holdWrites(seam.store);
      for (let index = 0; index < 3; index += 1) {
        void session.context.onFrame(frame(index));
        seam.probe.seal("t1");
      }
      seam.store.atomic(() => {
        for (let index = 0; index < 5; index += 1) seam.probe.enqueue("t1", `op-${index}`);
      });
      await hold.release();
      await seam.engine.flush();
      expect(session.aborted()).toBe(1);
      expect(session.log().applied.at(-1)?.facts).toBe(3);
    } finally {
      await seam.close();
    }
  });

  test("a reservation lost at promotion never acknowledges as success", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 2 } });
    seam.probe.useDeps("t1");
    try {
      seam.engine.rootAgent(thread("a"));
      seam.engine.rootAgent(thread("b"));
      await tick();
      let frameAck: Promise<void> | undefined;
      seam.store.atomic(() => {
        seam.engine.rootAgent(thread("c"));
        frameAck = seam.probe.nativeFrame("c", 0, 0, "stdio", JSON.stringify({ type: "x" }));
        seam.probe.enqueue("c", "staged");
        // The reservation is gone before the commit runs, as an invariant break would leave it.
        seam.probe.loseReservation("c");
      });
      const ack = track(frameAck!);
      await tick(24);
      expect(ack.error).toBe("Provider frame failed to commit");
      expect(
        errors(seam).some((message) =>
          message.includes("Engine actor capacity reservation lost for c"),
        ),
      ).toBe(true);
      expect(seam.engine.liveThreadIds()).toEqual(["a", "b"]);
    } finally {
      await seam.close();
    }
  });

  test("a same-transaction approval on a pledged victim persists the generation TS would persist", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 2 } });
    try {
      // A has no stored root, so `rootAgent(A)` must build a fresh actor and tick it.
      await seam.probe.attachSession("a", { translator: translator() });
      seam.engine.rootAgent(thread("b"));
      await tick();
      seam.probe.retire("a");
      seam.probe.retire("a");
      expect(seam.probe.generation("a")).toBe(2);
      seam.store.atomic(() => {
        seam.engine.rootAgent(thread("c"));
        seam.engine.rootAgent(thread("a"));
      });
      await tick();
      const applied = JSON.parse(seam.probe.applied("a")) as { generation: number }[];
      expect(applied.at(-1)?.generation).toBe(0);
      expect(seam.engine.liveThreadIds().toSorted()).toEqual(["a", "c"]);
      expect(seam.probe.generation("a")).toBe(0);
    } finally {
      await seam.close();
    }
    const rolled = await bareSeam({ limits: { maxActiveThreads: 2 } });
    try {
      await rolled.probe.attachSession("a", { translator: translator() });
      rolled.engine.rootAgent(thread("b"));
      await tick();
      rolled.probe.retire("a");
      rolled.probe.retire("a");
      expect(() =>
        rolled.store.atomic(() => {
          rolled.engine.rootAgent(thread("c"));
          rolled.engine.rootAgent(thread("a"));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      await tick();
      expect(rolled.engine.liveThreadIds()).toEqual(["a", "b"]);
      expect(rolled.probe.generation("a")).toBe(2);
    } finally {
      await rolled.close();
    }
  });

  test("a committed creation promotes the actor and evicts its victim before any pump turn", async () => {
    // (a) `signal-batching`; `index.ts:528`-`:562`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    seam.probe.useDeps("t1");
    try {
      seam.engine.rootAgent(thread("a"));
      seam.store.atomic(() => {
        seam.engine.rootAgent(thread("c"));
      });
      // The promotion ran at the commit: with max 1, a third lookup must evict c, not throw.
      expect(seam.engine.liveThreadIds()).toEqual(["c"]);
      expect(() => seam.engine.rootAgent(thread("d"))).not.toThrow();
      expect(seam.engine.liveThreadIds()).toEqual(["d"]);
    } finally {
      await seam.close();
    }
  });

  test("a victim evicted at commit settles the batch it had sealed", async () => {
    // (a) `resource-limits`
    const seam = await bareSeam({ limits: { maxActiveThreads: 2 } });
    seam.probe.useDeps("t1");
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      seam.engine.rootAgent(thread("b"));
      await tick();
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      seam.store.atomic(() => {
        seam.engine.rootAgent(thread("c"));
      });
      await tick();
      expect(ack.done).toBe(true);
      expect(ack.error).toBe("Provider frame failed to commit");
      expect(seam.engine.liveThreadIds().toSorted()).toEqual(["b", "c"]);
    } finally {
      await seam.close();
    }
  });

  test("a commit listener sees the promoted actor and its evicted victim", async () => {
    // (a) `index.ts:528`-`:562`; `transaction.ts:354`-`:381`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    seam.probe.useDeps("t1");
    try {
      seam.engine.rootAgent(thread("a"));
      const seen: string[][] = [];
      const stop = seam.store.subscribe(() => {
        seen.push(seam.engine.liveThreadIds());
      });
      try {
        seam.store.atomic(() => {
          seam.engine.rootAgent(thread("c"));
        });
      } finally {
        stop();
      }
      // Publication saw the commit's decision: c promoted, a evicted.
      expect(seen).toEqual([["c"]]);
    } finally {
      await seam.close();
    }
  });

  test("an eviction at the call lets the batch it had sealed commit", async () => {
    // (a) `resource-limits`; `actor.ts:599`-`:601`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      seam.engine.rootAgent(thread("b"));
      await tick();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      // The sealed batch folded; the lookup that evicted it also applied its own tick.
      expect(session.log().applied[0]?.facts).toBe(1);
      expect(seam.engine.liveThreadIds()).toEqual(["b"]);
    } finally {
      await seam.close();
    }
  });

  test("a frame waiting on the writer when its actor is evicted releases its handle", async () => {
    // (a) `live-write-buffer`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      const hold = holdWrites(seam.store);
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      // The op is taken and parked on the store's writable gate when the victim leaves.
      await tick();
      await seam.probe.attachSession("b", { translator: translator() });
      await hold.release();
      await tick(24);
      expect(ack.error).toBe("Provider frame failed to commit");
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an evicted actor with no replacement leaves no waker registered", async () => {
    // (a) `signal-batching`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    await seam.probe.attachSession("a", { translator: translator() });
    try {
      await tick();
      expect(seam.probe.registeredWakers()).toBe(1);
      seam.engine.rootAgent(thread("b"));
      await tick(24);
      expect(seam.engine.liveThreadIds()).toEqual(["b"]);
      expect(seam.probe.registeredWakers()).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("an evicted actor's task never folds its batch into the replacement", async () => {
    // (a) `reliability`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      seam.probe.failApply("a", 1);
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      // The batch is parked on the store's retry; now evict a and recreate it, same generation.
      expect(ack.done).toBe(false);
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      // The lookups themselves apply a tick; the evicted batch must not add another.
      const before = session.log().applied.length;
      seam.clock.advance(seam.clock.time + 100);
      await tick(24);
      expect(ack.error).toBe("Provider frame failed to commit");
      expect(session.log().applied.length).toBe(before);
    } finally {
      await seam.close();
    }
  });
});
