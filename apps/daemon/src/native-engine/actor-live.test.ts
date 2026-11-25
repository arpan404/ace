// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the live buffer's acknowledgement and flush. Switch on, addon built with `engine-probe`. Each case names the (a)
 * file that will show it and is deleted when that file passes with the switch on.
 */

import { describe, expect, test } from "vitest";

import { frame, native, streamSeam, tick, track } from "./actor-support.ts";

describe.runIf(native)("the native actor and frames", () => {
  test("(step 16) established deltas are acknowledged when the live buffer accepts them, before it flushes", async () => {
    // (a) `signal-batching` `:114`, `:186`
    const { seam, session, threadId } = await streamSeam();
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();

      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(seam.store.hasLiveWrite(threadId)).toBe(true);
      expect(session.log().snapshots).toEqual([]);
      seam.clock.advance(seam.clock.time + 100);
      // A flush timer never attempts inline: the pump runs it in a later macrotask.
      expect(session.log().snapshots).toEqual([]);
      await tick();
      expect(session.log().snapshots).toEqual(["persist", "committed"]);
      expect(seam.store.hasLiveWrite(threadId)).toBe(false);
    } finally {
      await seam.close();
    }
  });

  test("two live appends before a flush retire the older snapshot's token", async () => {
    // (a) `live-write-buffer`
    const { seam, session, threadId } = await streamSeam();
    try {
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      void session.context.onFrame(frame(1));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      expect(seam.store.hasLiveWrite(threadId)).toBe(true);
      expect(seam.probe.liveTokens()).toBe(1);
      seam.clock.advance(seam.clock.time + 100);
      await tick();
      expect(seam.probe.liveTokens()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("a quarantined live batch retires its snapshot's token", async () => {
    // (a) `live-write-quarantine`
    const { seam, session, threadId } = await streamSeam();
    try {
      seam.probe.failPersistFatal(threadId, 1);
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      expect(seam.probe.liveTokens()).toBe(1);
      // Six strikes quarantine the thread's share, dropping it instead of storing it.
      for (let strike = 0; strike < 7; strike += 1) {
        seam.clock.advance(seam.clock.time + 6_000);
        await tick(24);
      }
      expect(seam.probe.liveTokens()).toBe(0);
      expect(seam.store.hasLiveWrite(threadId)).toBe(false);
    } finally {
      await seam.close();
    }
  });

  test("(step 16) a live batch whose first attempt fails is retried as a pump task and stored", async () => {
    const { seam, session, threadId } = await streamSeam();
    try {
      seam.probe.failPersist(threadId, 1);
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      expect(seam.store.hasLiveWrite(threadId)).toBe(true);
      seam.clock.advance(seam.clock.time + 100);
      await tick();
      expect(session.log().snapshots).toEqual(["persist"]);
      expect(seam.store.liveWriteBlocked()).toBe(true);
      let proceeded = false;
      const waiting = seam.store.writable().then(() => {
        proceeded = true;
      });
      await tick();
      expect(proceeded).toBe(false);
      seam.clock.advance(seam.clock.time + 5_000);
      await tick(24);
      await waiting;
      expect(session.log().snapshots).toEqual(["persist", "persist", "committed"]);
      expect(seam.store.hasLiveWrite(threadId)).toBe(false);
    } finally {
      await seam.close();
    }
  });
});
