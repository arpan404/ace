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
  native,
  seamWithSession,
  tick,
  track,
  watchEvents,
} from "./actor-support.ts";

describe.runIf(native)("the native actor and frames", () => {
  test("native frames batch and acknowledge as TypeScript ones do", async () => {
    const { seam, session } = await seamWithSession();
    seam.probe.attachNativeTranslator("t1");
    const watched = watchEvents(seam);
    try {
      const promises = [0, 1, 2].map((index) =>
        seam.probe.nativeFrame("t1", 0, index, "stdio", JSON.stringify({ type: "x" })),
      );
      const states = promises.map(track);
      await tick(2);
      expect(states.map((state) => state.done)).toEqual([false, false, false]);
      seam.clock.advance(seam.clock.time + 1);
      await seam.engine.flush();
      expect(states.map((state) => state.done)).toEqual([true, true, true]);
      expect(states.every((state) => state.error === undefined)).toBe(true);
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([3]);
      expect(watched.seen).toContain("probe.batch");
    } finally {
      watched.stop();
      await seam.close();
    }
  });

  test("native frames over a payload limit are skipped with the bridge's warning", async () => {
    const { seam } = await seamWithSession();
    try {
      const tooBig = `"${"x".repeat(1024 * 1024)}"`;
      const tooMany = JSON.stringify(Array.from({ length: 32_769 }, () => 0));
      // Invalid JSON cannot be a `Raw`, so the constructor's parse error is a Rust unit test.
      seam.probe.bridgeFrame("t1", 0, 0, "stdio", tooBig);
      seam.probe.bridgeFrame("t1", 0, 1, "stdio", tooMany);
      await tick();
      const warnings = errors(seam).filter((message) =>
        message.includes("native session frame event failed: "),
      );
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toContain("Provider payload exceeds byte limit");
      expect(warnings[1]).toContain("Provider payload exceeds structural limit");
      expect(seam.engine.workload().queues["engine.frames"]).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("the native flow mirror pauses once and resumes when the wait resolves, per frame", async () => {
    const { seam, session } = await seamWithSession({ limits: { maxQueuedFrames: 2 } });
    try {
      // One queued frame reaches the tiny pause threshold; no op runs before the pump.
      void session.context.onFrame(frame(0));
      seam.probe.seal("t1");
      expect(session.context.outputFlow.paused()).toBe(true);
      seam.probe.nativeFlow("t1");
      expect(session.log().flowed).toEqual([true]);
      await seam.engine.flush();
      await tick();
      expect(session.log().flowed).toEqual([true, false]);
    } finally {
      await seam.close();
    }
  });

  test("a batch's acknowledgement continuation runs before an exit queued behind it retires the generation", async () => {
    // (a) `engine/sessions.ts:685`–`:711`
    const { seam, session } = await seamWithSession();
    try {
      let generationAtAck: number | undefined;
      const batch = session.context.onFrame(frame(0));
      void batch.then(() => {
        generationAtAck = seam.probe.generation("t1");
      });
      seam.probe.enqueueRetire("t1");
      await seam.engine.flush();
      await tick();
      expect(generationAtAck).toBe(0);
      expect(seam.probe.generation("t1")).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("a session replaced during translation keeps the new translator", async () => {
    const seam = await bareSeam();
    try {
      let attached = false;
      const second = {
        translate: () => [{ type: "signal" }, { type: "signal" }],
        tick: () => [{ type: "signal" }],
        takeDiagnostics: () => [],
      } as never;
      const first = {
        translate: () => {
          if (!attached) {
            attached = true;
            // The attach runs synchronously inside this call, as a re-entrant port would.
            void seam.probe.attachSession("t1", { translator: second });
          }
          return [{ type: "signal" }];
        },
        tick: () => [{ type: "signal" }],
        takeDiagnostics: () => [],
      } as never;
      const session = await seam.probe.attachSession("t1", { translator: first });
      void session.context.onFrame(frame(0));
      seam.clock.advance(seam.clock.time + 1);
      await seam.engine.flush();
      void session.context.onFrame(frame(1));
      seam.clock.advance(seam.clock.time + 1);
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 2]);
      expect(errors(seam).some((message) => message.includes("Reentrant"))).toBe(false);
    } finally {
      await seam.close();
    }
  });

  test("a frame batch sealed inside a rolled-back transaction is still folded and acknowledged", async () => {
    const { seam, session } = await seamWithSession();
    try {
      let batch: Promise<void> | undefined;
      expect(() =>
        seam.store.atomic(() => {
          batch = session.context.onFrame(frame(0));
          seam.probe.seal("t1");
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      const ack = track(batch!);
      await seam.engine.flush();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1]);
    } finally {
      await seam.close();
    }
  });

  test("an enqueue made inside a rolled-back transaction never runs, and one inside a committed transaction runs in its call order", async () => {
    const { seam, session } = await seamWithSession();
    try {
      expect(() =>
        seam.store.atomic(() => {
          void session.context.onFrame(frame(0));
          seam.probe.enqueue("t1", "first");
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      seam.store.atomic(() => {
        void session.context.onFrame(frame(1));
        seam.probe.enqueue("t1", "second");
      });
      await seam.engine.flush();
      expect(session.log().enqueued).toEqual(["second"]);
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([1, 1]);
      expect(seam.engine.workload().queues["engine.frames"]).toBe(0);
    } finally {
      await seam.close();
    }
  });

  test("a native frame whose commit fails notifies the session's read gate", async () => {
    // (a) `sdk-burst`
    const { seam, session } = await seamWithSession();
    try {
      seam.probe.attachNativeTranslator("t1");
      seam.probe.failApplyFatal("t1", 1);
      seam.probe.bridgeFrame("t1", 0, 0, "stdio", JSON.stringify({ type: "x" }));
      seam.clock.advance(seam.clock.time + 1);
      await tick(24);
      await seam.engine.flush();
      expect(session.log().nativeAcks).toEqual(["rejected:Provider frame failed to commit"]);
    } finally {
      await seam.close();
    }
  });

  test("a batch allocates one promise, however many frames join it", async () => {
    // (a) `signal-batching` (decision 4)
    const { seam, session } = await seamWithSession();
    try {
      const counter = seam.engine as unknown as { allocatedFrameCalls: number };
      const before = counter.allocatedFrameCalls;
      void session.context.onFrame(frame(0));
      void session.context.onFrame(frame(1));
      void session.context.onFrame(frame(2));
      expect(counter.allocatedFrameCalls - before).toBe(1);
      await seam.engine.flush();
      expect(session.log().applied.map((entry) => entry.facts)).toEqual([3]);
    } finally {
      await seam.close();
    }
  });

  test("two frames of one batch read the clock per frame", async () => {
    // (a) `signal-batching`
    const seen: number[] = [];
    let advance: (() => void) | undefined;
    const clocked = {
      translate: (_frame: unknown, now: number) => {
        seen.push(now);
        advance?.();
        return [{ type: "signal" }];
      },
      tick: () => [{ type: "signal" }],
      takeDiagnostics: () => [],
    } as never;
    const seam = await bareSeam();
    try {
      const session = await seam.probe.attachSession("t1", { translator: clocked });
      advance = () => seam.clock.advance(seam.clock.time + 5);
      void session.context.onFrame(frame(0));
      void session.context.onFrame(frame(1));
      await seam.engine.flush();
      expect(seen.length).toBe(2);
      expect(seen[1]! - seen[0]!).toBe(5);
    } finally {
      await seam.close();
    }
  });

  test("a usage frame with its own account keeps the account and its billing mode", async () => {
    // (a) `signal-batching`
    const usage = {
      translate: () => [{ type: "usage" }],
      tick: () => [{ type: "signal" }],
      takeDiagnostics: () => [],
    } as never;
    const seam = await bareSeam();
    try {
      const session = await seam.probe.attachSession("t1", { translator: usage });
      const account = { id: "acct-1", billingMode: "subscription", provider: "claude" };
      void session.context.onFrame({ ...frame(0), usageAccount: account } as unknown as Frame);
      await seam.engine.flush();
      const facts = session.log().facts;
      expect(facts[0]).toMatchObject({ accountId: "acct-1", billingMode: "subscription" });
    } finally {
      await seam.close();
    }
  });

  test("an SDK frame with a branded payload of different data fails the certificate, not the envelope", async () => {
    // (a) `sdk-burst`
    const { seam, session } = await seamWithSession();
    try {
      const certified = scriptFrames().frame({ type: "tick" });
      const mismatched = {
        ...certified,
        channel: "sdk",
        data: { type: "other" },
      } as unknown as Frame;
      const ack = track(session.context.onFrame(mismatched));
      await seam.engine.flush();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(
        errors(seam).some((message) =>
          message.includes("SDK frame lacks matching encoded admission certificate"),
        ),
      ).toBe(true);
      expect(
        errors(seam).some((message) => message.includes("Provider frame envelope is malformed")),
      ).toBe(false);
    } finally {
      await seam.close();
    }
  });

  test("a retryable attachment lookup does not translate the batch twice", async () => {
    // (a) `attachment-echo`
    let translations = 0;
    const hash = "a".repeat(64);
    const carrier = {
      translate: () => {
        translations += 1;
        return [
          {
            type: "item.upsert",
            agent: "root",
            item: "message",
            draft: {
              type: "message",
              role: "user",
              raw: [{ data: { path: `/tmp/${hash}.png` } }],
            },
          },
        ];
      },
      tick: () => [{ type: "signal" }],
      takeDiagnostics: () => [],
    } as never;
    const seam = await bareSeam();
    try {
      const session = await seam.probe.attachSession("t1", { translator: carrier });
      seam.probe.failAttachment("t1", 1);
      const ack = track(session.context.onFrame(frame(0)));
      seam.clock.advance(seam.clock.time + 1);
      await tick();
      seam.clock.advance(seam.clock.time + 100);
      await seam.engine.flush();
      expect(ack.done).toBe(true);
      expect(ack.error).toBeUndefined();
      expect(translations).toBe(1);
      expect(session.log().applied.length).toBe(1);
    } finally {
      await seam.close();
    }
  });

  test("a Cursor batch commits its frame record, facts and queue sync in one transaction", async () => {
    // (a) `streaming-behaviour`
    const { seam, session } = await seamWithSession();
    try {
      seam.probe.attachNativeTranslator("t1");
      seam.probe.useCursorRoute("t1");
      void seam.probe.nativeFrame("t1", 0, 0, "sdk", JSON.stringify({ kind: "send" }));
      seam.probe.seal("t1");
      await seam.engine.flush();
      const log = session.log();
      expect(log.journal.length).toBe(1);
      expect(log.journalInTransaction).toEqual([true]);
      expect(log.journal[0]).toMatchObject({
        beginsTurn: true,
        frame: { channel: "sdk", seq: 0, dir: "recv" },
      });
      // The apply nested inside the batch's one transaction.
      expect(log.applied[0]?.outermost).toBe(false);
      expect(log.applied[0]?.committed).toBe(true);
    } finally {
      await seam.close();
    }
  });
});
