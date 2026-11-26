// SPDX-License-Identifier: Apache-2.0
import type { ThreadId } from "@ace/protocol";
import { describe, expect, test } from "vitest";

import { bareSeam, frame, holdWrites, native, tick, track, translator } from "./actor-support.ts";

const thread = (id: string): ThreadId => id as ThreadId;

describe.runIf(native)("evicted actor effects", () => {
  test("late frames from an evicted session drop even at the replacement's generation", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const original = await seam.probe.attachSession("a", { translator: translator() });
      await seam.probe.attachSession("b", { translator: translator() });
      const replacement = await seam.probe.attachSession("a", { translator: translator() });
      await Promise.all([original.context.onFrame(frame(0)), seam.engine.flush()]);
      expect(replacement.log().applied).toEqual([]);
      expect(seam.probe.liveFrames()).toBe(0);
      await Promise.all([replacement.context.onFrame(frame(1)), seam.engine.flush()]);
      expect(replacement.log().applied.map((entry) => entry.facts)).toEqual([1]);
    } finally {
      await seam.close();
    }
  });

  test("an evicted session's flow ignores the replacement's backlog", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1, maxQueuedFrames: 4 } });
    try {
      const original = await seam.probe.attachSession("a", { translator: translator() });
      await seam.probe.attachSession("b", { translator: translator() });
      const replacement = await seam.probe.attachSession("a", { translator: translator() });
      const frameAck = track(replacement.context.onFrame(frame(0)));
      const oldPaused = original.context.outputFlow.paused();
      const oldWait = track(original.context.outputFlow.wait());
      const newWait = track(replacement.context.outputFlow.wait());
      await tick();
      expect(replacement.context.outputFlow.paused()).toBe(true);
      expect(frameAck.done).toBe(false);
      expect(newWait.done).toBe(false);
      expect(oldPaused).toBe(false);
      expect(oldWait.done).toBe(true);
      await seam.engine.flush();
    } finally {
      await seam.close();
    }
  });

  test("overflow aborts only the evicted session's lifetime", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1, maxQueuedFrames: 1 } });
    try {
      const original = await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.enqueue("a", "accepted");
      seam.probe.enqueue("a", "overflow");
      seam.engine.rootAgent(thread("b"));
      const replacement = await seam.probe.attachSession("a", { translator: translator() });
      await seam.engine.flush();
      expect(original.aborted()).toBe(1);
      expect(replacement.aborted()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("eviction leaves no stopping entry when the task has already exited", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      await seam.probe.attachSession("a", { translator: translator() });
      await tick();
      expect(seam.probe.registeredWakers()).toBe(1);
      seam.probe.stopActor("a");
      await seam.engine.flush();
      expect(seam.probe.registeredWakers()).toBe(0);
      seam.engine.rootAgent(thread("b"));
      expect(seam.probe.stoppingCount()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("the close deadline releases an evicted batch still waiting for the writer", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    const session = await seam.probe.attachSession("a", { translator: translator() });
    const hold = holdWrites(seam.store);
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      await tick();
      await seam.probe.attachSession("b", { translator: translator() });
      expect(seam.probe.stoppingCount()).toBe(1);
      const deadline = seam.clock.waitForDelay(4_500);
      const closing = seam.engine.close();
      await deadline;
      seam.clock.advance(seam.clock.time + 4_500);
      await closing;
      expect(ack.error).toBe("Engine closed");
      expect(seam.probe.stoppingCount()).toBe(0);
      expect(seam.probe.registeredWakers()).toBe(0);
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await hold.release();
      await seam.close();
    }
  });

  test("a queued retirement leaves the replacement generation intact", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.enqueueRetire("a");
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      await seam.engine.flush();
      expect(session.log().expired).toEqual([0]);
      expect(seam.probe.generation("a")).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an evicted overflow leaves the replacement deadline armed", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1, maxQueuedFrames: 1 } });
    try {
      await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.enqueue("a", "accepted");
      seam.probe.enqueue("a", "overflow");
      seam.engine.rootAgent(thread("b"));
      const deadline = seam.clock.time + 50;
      const replacement = await seam.probe.attachSession("a", {
        translator: translator(() => (seam.clock.time < deadline ? deadline : undefined)),
      });
      seam.probe.schedule("a");
      await tick();
      seam.clock.advance(deadline);
      await tick();
      expect(replacement.log().applied.at(-1)?.facts).toBe(2);
    } finally {
      await seam.close();
    }
  });

  test("a failed evicted batch leaves the replacement writable and its frame held", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      const old = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      const skipped = track(session.context.onFrame(frame(1)));
      seam.probe.seal("a");
      seam.engine.rootAgent(thread("b"));
      seam.probe.failApplyFatal("a", 1);
      const fresh = await seam.probe.attachSession("a", { translator: translator() });
      const replacement = track(fresh.context.onFrame(frame(2)));
      await tick();
      expect(old.error).toBe("Provider frame failed to commit");
      expect(skipped.error).toBe("Provider frame failed to commit");
      expect(replacement.done).toBe(false);
      expect(seam.probe.liveFrames()).toBe(1);
      seam.probe.seal("a");
      await seam.engine.flush();
      expect(replacement.done).toBe(true);
      expect(replacement.error).toBeUndefined();
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("an evicted task exits without unregistering its replacement waker", async () => {
    const seam = await bareSeam({ limits: { maxActiveThreads: 1 } });
    try {
      const session = await seam.probe.attachSession("a", { translator: translator() });
      seam.probe.failApply("a", 1);
      const retryArmed = seam.clock.waitForDelay(100);
      const old = track(session.context.onFrame(frame(0)));
      seam.probe.seal("a");
      await retryArmed;
      seam.engine.rootAgent(thread("b"));
      seam.engine.rootAgent(thread("a"));
      await tick();
      expect(seam.probe.stoppingCount()).toBe(1);
      expect(seam.probe.registeredWakers()).toBe(1);
      seam.clock.advance(seam.clock.time + 100);
      await seam.engine.flush();
      expect(old).toEqual({ done: true });
      expect(seam.probe.stoppingCount()).toBe(0);
      expect(seam.probe.registeredWakers()).toBe(1);
      seam.probe.enqueue("a", "replacement");
      await tick();
      expect(session.log().enqueued).toEqual(["replacement"]);
    } finally {
      await seam.close();
    }
  });
});
