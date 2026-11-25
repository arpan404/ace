// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the actor and frames on their own (batching, acknowledgement, flow). Switch on, addon built with `engine-probe`. Each case names the (a)
 * file that will show it and is deleted when that file passes with the switch on.
 */
import type { Frame } from "@ace/engine-api";

import { describe, expect, test } from "vitest";

import { scriptFrames } from "../engine/test-support.ts";

import {
  bareSeam,
  errors,
  frame,
  holdWrites,
  native,
  seamWithSession,
  tick,
  track,
} from "./actor-support.ts";

describe.runIf(native)("the native actor and frames", () => {
  test("intake pauses at 256 queued frames and resumes at 64", async () => {
    // (a) `signal-batching`
    const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 1024 } });
    try {
      const hold = holdWrites(seam.store);
      for (let index = 0; index < 255; index += 1) {
        void session.context.onFrame(frame(index));
        seam.probe.seal("t1");
      }
      expect(session.context.outputFlow.paused()).toBe(false);
      void session.context.onFrame(frame(255));
      seam.probe.seal("t1");
      expect(session.context.outputFlow.paused()).toBe(true);
      let resolved = false;
      const waited = session.context.outputFlow.wait().then(() => {
        resolved = true;
      });
      await tick();
      expect(resolved).toBe(false);
      await hold.release();
      await waited;
      expect(session.context.outputFlow.paused()).toBe(false);
      expect(seam.engine.workload().queues["engine.frames"]).toBeLessThanOrEqual(64);
    } finally {
      await seam.close();
    }
  });

  test("a full mailbox commits the accepted prefix, then ends the session visibly", async () => {
    // (a) `resource-limits`
    const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 8 } });
    try {
      const accepted = [];
      for (let index = 0; index < 8; index += 1) {
        accepted.push(track(session.context.onFrame(frame(index))));
        seam.probe.seal("t1");
      }
      const overflowed = track(session.context.onFrame(frame(8)));
      seam.probe.seal("t1");
      // The refusal set `overflowed`; the next frame sees it at intake.
      const after = track(session.context.onFrame(frame(9)));
      await seam.engine.flush();
      expect(accepted.every((ack) => ack.done)).toBe(true);
      expect(overflowed.error).toBe("Provider frame failed to commit");
      expect(after.error).toBe("Provider mailbox capacity exceeded");
      expect(session.aborted()).toBe(1);
      const applied = session.log().applied;
      expect(applied.slice(0, 8).map((entry) => entry.facts)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      expect(applied.at(-1)?.facts).toBe(3);
    } finally {
      await seam.close();
    }
  });

  test("a malformed envelope fails the actor and the frame's promise resolves after the flush", async () => {
    const { seam, session } = await seamWithSession();
    try {
      const malformed = track(session.context.onFrame({ ...frame(0), seq: -1 }));
      await seam.engine.flush();
      expect(malformed.done).toBe(true);
      expect(malformed.error).toBeUndefined();
      expect(
        errors(seam).some((message) =>
          message.includes("Provider frame envelope is malformed: seq"),
        ),
      ).toBe(true);
      const next = track(session.context.onFrame(frame(1)));
      await tick();
      expect(next.error).toBe("Provider frame failed to commit");
    } finally {
      await seam.close();
    }
  });

  test("an SDK frame without its certificate and an oversized frame fail the actor visibly", async () => {
    // (a) `sdk-burst`
    const first = await seamWithSession();
    try {
      const sdk = track(
        first.session.context.onFrame({ ...frame(0), channel: "sdk" } as unknown as Frame),
      );
      await first.seam.engine.flush();
      expect(sdk.done).toBe(true);
      expect(sdk.error).toBeUndefined();
      expect(
        errors(first.seam).some((message) =>
          message.includes("SDK frame lacks matching encoded admission certificate"),
        ),
      ).toBe(true);
    } finally {
      await first.seam.close();
    }
    const second = await seamWithSession({ limits: { maxFrameBytes: 100 } });
    try {
      const certified = scriptFrames().frame({ type: "tick" });
      const oversized = track(second.session.context.onFrame(certified));
      await second.seam.engine.flush();
      expect(oversized.done).toBe(true);
      expect(oversized.error).toBeUndefined();
      expect(
        errors(second.seam).some((message) => message.includes("Provider frame capacity exceeded")),
      ).toBe(true);
    } finally {
      await second.seam.close();
    }
  });

  test("flush waits for a batch parked on its retry timer", async () => {
    // (a) `signal-batching`, `reliability`
    const { seam, session } = await seamWithSession();
    try {
      seam.probe.failApply("t1", 1);
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      // The batch is in flight, parked on the store's 100 ms retry: the mailbox holds no op.
      let flushed = false;
      const flushing = seam.engine.flush().then(() => {
        flushed = true;
      });
      await tick();
      expect(flushed).toBe(false);
      expect(ack.done).toBe(false);
      seam.clock.advance(seam.clock.time + 100);
      await flushing;
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("a busy store retries the batch every 100 ms and translates it once", async () => {
    // (a) `reliability`
    let translations = 0;
    const counting = {
      translate: () => {
        translations += 1;
        return [{ type: "signal" }];
      },
      tick: () => [{ type: "signal" }],
      takeDiagnostics: () => [],
    } as never;
    const seam = await bareSeam();
    try {
      const session = await seam.probe.attachSession("t1", { translator: counting });
      seam.probe.failApply("t1", 2);
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      seam.clock.advance(seam.clock.time + 100);
      await tick();
      seam.clock.advance(seam.clock.time + 100);
      await seam.engine.flush();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(translations).toBe(1);
      expect(session.log().applied.length).toBe(1);
      expect(session.log().applied[0]?.committed).toBe(true);
    } finally {
      await seam.close();
    }
  });

  test("a frame of a retired generation is acknowledged and dropped", async () => {
    const { seam, session } = await seamWithSession();
    try {
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      expect(session.log().applied.length).toBe(1);
      session.retire();
      let settled = false;
      await session.context.onFrame(frame(1)).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(settled).toBe(true);
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("acknowledgements never resolve inside a transaction", async () => {
    const { seam, session } = await seamWithSession();
    try {
      const ack = track(session.context.onFrame(frame(0)));
      seam.probe.runInTransaction("t1");
      await tick();
      expect(ack.error).toBe("Provider frame failed to commit");
      expect(
        errors(seam).some((message) =>
          message.includes("acknowledgement reached with a transaction open"),
        ),
      ).toBe(true);
    } finally {
      await seam.close();
    }
  });
  test("an enqueued op opens its own transaction", async () => {
    // (a) `signal-batching`; `actor.ts:191`-`:197`
    const { seam, session } = await seamWithSession();
    try {
      seam.probe.enqueue("t1", "one");
      await seam.engine.flush();
      expect(session.log().enqueued).toEqual(["one"]);
      expect(session.log().opsOutermost).toEqual([true]);
    } finally {
      await seam.close();
    }
  });

  test("overflow waits for the writable gate before ending the session", async () => {
    // (a) `resource-limits`; `actor.ts:203`-`:237`
    const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 2 } });
    try {
      const hold = holdWrites(seam.store);
      for (let index = 0; index < 3; index += 1) {
        void session.context.onFrame(frame(index));
        seam.probe.seal("t1");
      }
      expect(session.aborted()).toBe(0);
      await hold.release();
      await seam.engine.flush();
      expect(session.aborted()).toBe(1);
      expect(session.log().applied.at(-1)?.facts).toBe(3);
      // The refused batch released its frame objects with its acknowledgement.
      expect(seam.probe.liveFrames()).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("a timer's tick keeps its place ahead of an exit enqueued after it", async () => {
    // (a) `actor-timer`
    let clock = 0;
    const { seam, session } = await seamWithSession({ deadline: () => clock + 1000 });
    try {
      clock = seam.clock.now();
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      seam.clock.advance(clock + 1000);
      // The exit is enqueued after the firing but before any pump turn.
      seam.probe.enqueue("t1", "exit");
      await seam.engine.flush();
      expect(session.log().order).toEqual(["apply", "apply", "op:exit"]);
    } finally {
      await seam.close();
    }
  });

  test("a tick caught by intake inside a rolled-back transaction still runs", async () => {
    // (a) `actor-timer`
    let clock = 0;
    const { seam, session } = await seamWithSession({ deadline: () => clock + 1000 });
    try {
      clock = seam.clock.now();
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      seam.clock.advance(clock + 1000);
      expect(() =>
        seam.store.atomic(() => {
          void session.context.onFrame(frame(1));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      await seam.engine.flush();
      const applied = session.log().applied;
      // The tick fired before the frame arrived, so it folds first, then the frame's batch.
      expect(applied.map((entry) => entry.facts)).toEqual([1, 2, 1]);
    } finally {
      await seam.close();
    }
  });

  test("a tick whose apply is busy retries instead of poisoning the actor", async () => {
    // (a) `actor-timer`
    let clock = 0;
    const { seam, session } = await seamWithSession({ deadline: () => clock + 1000 });
    try {
      clock = seam.clock.now();
      void session.context.onFrame(frame(0));
      await seam.engine.flush();
      seam.probe.failApply("t1", 1);
      seam.clock.advance(clock + 1000);
      await tick();
      seam.clock.advance(seam.clock.time + 100);
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 2]);
      // Not poisoned: the next frame still folds.
      void session.context.onFrame(frame(1));
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 2, 1]);
    } finally {
      await seam.close();
    }
  });
});
