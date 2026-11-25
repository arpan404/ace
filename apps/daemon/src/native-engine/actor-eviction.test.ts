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
  tick,
  track,
  translator,
} from "./actor-support.ts";
const thread = (id: string): ThreadId => id as ThreadId;

describe.runIf(native)("the native actor and frames", () => {
  test("a victim evicted at commit lets the batch it had sealed commit", async () => {
    // (a) `resource-limits`; `actor.ts:599`-`:601`
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
      await seam.engine.flush();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(session.log().applied.some((entry) => entry.facts === 1)).toBe(true);
      expect(seam.engine.liveThreadIds().toSorted()).toEqual(["b", "c"]);
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
      // The in-flight op cannot be moved to the drain: it settles as an orphan, released.
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

  test("a busy store during an eviction's drain retries instead of failing the actor", async () => {
    // (a) `reliability`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      // The eviction's own lookup applies a tick; inject the busy error after it.
      seam.engine.rootAgent(thread("b"));
      seam.probe.failApply("a", 1);
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      seam.clock.advance(seam.clock.time + 100);
      await seam.engine.flush();
      await tick(8);
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(session.log().applied.some((entry) => entry.facts === 1)).toBe(true);
      expect(errors(seam)).toEqual([]);
    } finally {
      await seam.close();
    }
  });

  test("a failing drain stops at the poison and releases the batches behind it", async () => {
    // (a) `resource-limits`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      const first = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      const second = track(session.context.onFrame(frame(1)));
      seam.probe.seal("a");
      seam.engine.rootAgent(thread("b"));
      seam.probe.failApplyFatal("a", 1);
      await seam.engine.flush();
      await tick(8);
      expect(first.error).toBe("Provider frame failed to commit");
      expect(second.error).toBe("Provider frame failed to commit");
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an overflow op waiting at the eviction still ends the session", async () => {
    // (a) `resource-limits`
    const seam = await bareSeam({ limits: { maxActiveThreads: 1, maxQueuedFrames: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    try {
      void session.context.onFrame(frame(0));
      seam.probe.seal("a");
      void session.context.onFrame(frame(1));
      seam.probe.seal("a");
      seam.engine.rootAgent(thread("b"));
      await seam.engine.flush();
      await tick(8);
      expect(session.aborted()).toBe(1);
      expect(session.log().applied.at(-1)?.facts).toBe(3);
    } finally {
      await seam.close();
    }
  });

  test("frames of a retired generation release their handles when the fold skips them", async () => {
    const seam = await bareSeam();
    const session = await seam.probe.attachSession("t1", { translator: translator() });
    try {
      void session.context.onFrame(frame(0));
      seam.probe.retire("t1");
      seam.probe.seal("t1");
      await seam.engine.flush();
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });
});
