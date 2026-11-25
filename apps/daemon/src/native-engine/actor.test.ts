// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the actor and frames on their own (batching, acknowledgement, flow). Switch on, addon built with `engine-probe`. Each case names the (a)
 * file that will show it and is deleted when that file passes with the switch on.
 */

import type { ThreadId } from "@ace/protocol";
import { describe, expect, test } from "vitest";

import {
  frame,
  native,
  seamWithSession,
  storedTypes,
  tick,
  track,
  watchEvents,
} from "./actor-support.ts";
const thread = (id: string): ThreadId => id as ThreadId;

describe.runIf(native)("the native actor and frames", () => {
  test("a batch's frames are acknowledged after its commit, never before", async () => {
    // (a) `signal-batching` `:160`
    const { seam, session } = await seamWithSession();
    const watched = watchEvents(seam);
    try {
      const order: number[] = [];
      const promises = [0, 1, 2].map((index) =>
        session.context.onFrame(frame(index)).then(() => {
          order.push(index);
        }),
      );
      await tick(2);
      expect(order).toEqual([]);
      seam.clock.advance(seam.clock.time + 1);
      await seam.engine.flush();
      await Promise.all(promises);
      expect(order).toEqual([0, 1, 2]);
      const log = session.log();
      expect(log.applied.length).toBe(1);
      expect(log.applied[0]?.outermost).toBe(true);
      expect(log.applied[0]?.committed).toBe(true);
      expect(watched.seen).toContain("probe.batch");
      // A real row, so a publication-only implementation cannot pass this test.
      expect(storedTypes(seam, thread("t1"))).toEqual(["probe.batch"]);
    } finally {
      watched.stop();
      await seam.close();
    }
  });

  test("a batch seals at 256 frames or 256 KiB without waiting for its timer", async () => {
    // (a) `signal-batching`
    const { seam, session } = await seamWithSession();
    try {
      for (let index = 0; index < 256; index += 1) {
        void session.context.onFrame(frame(index));
      }
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([256]);
      const wide = "y".repeat(130 * 1024);
      void session.context.onFrame(frame(300, { type: "x", payload: wide }));
      void session.context.onFrame(frame(301, { type: "x", payload: wide }));
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([256, 2]);
    } finally {
      await seam.close();
    }
  });

  test("a frame that arrives after the batch timer fired joins the next batch", async () => {
    const { seam, session } = await seamWithSession();
    try {
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      void session.context.onFrame(frame(1));
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 1]);
    } finally {
      await seam.close();
    }
  });

  test("a batch whose timer fires with no later frame, flush or tick is still committed", async () => {
    const { seam, session } = await seamWithSession();
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      expect(ack.done).toBe(true);
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("an actor tick that fires on an idle actor runs", async () => {
    let clock = 0;
    const { seam, session } = await seamWithSession({
      deadline: () => clock + 1000,
    });
    try {
      clock = seam.clock.now();
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      expect(session.log().applied.length).toBe(1);
      seam.clock.advance(clock + 1000);
      await tick();
      const applied = session.log().applied;
      expect(applied.length).toBe(2);
      // The translator's tick facts, then the engine's own tick.
      expect(applied[1]?.facts).toBe(2);
    } finally {
      await seam.close();
    }
  });
});
