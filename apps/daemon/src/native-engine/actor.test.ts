// SPDX-License-Identifier: Apache-2.0
/**
 * E5.2's native proof: the actor and frames behind `ACE_ENGINE=native`. Switch on, addon built
 * with `engine-probe`. Each case names the (a) file that will show it and is deleted when that
 * file passes with the switch on.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { describe, expect, test } from "vitest";
import { createDevThread } from "../commands.ts";
import { scriptFrames } from "../engine/test-support.ts";
import { engineSeam, type EngineSeam, type ProbeSession } from "./testing.ts";

const native = engineBackend() === "native";

/** A thread id the facade expects, for the creation cases. */
const thread = (id: string): ThreadId => id as ThreadId;

/** A translator with no state: one signal fact per frame. */
function translator(nextDeadline?: () => number | undefined) {
  return {
    translate: () => [{ type: "signal" }],
    tick: (now: number) => [{ type: "signal", agent: "root", t: now }],
    takeDiagnostics: () => [],
    ...(nextDeadline === undefined ? {} : { nextDeadline }),
  } as never;
}

/** A translator whose frames are established deltas, so `stream()` accepts them. */
function deltaTranslator() {
  return {
    translate: () => [{ type: "item.delta", agent: "root", item: "i", field: "text", append: "x" }],
    tick: (now: number) => [{ type: "signal", agent: "root", t: now }],
    takeDiagnostics: () => [],
  } as never;
}

function frame(seq: number, data: unknown = { type: "x" }): Frame {
  return { seq, t: seq, dir: "recv", channel: "stdio", data } as unknown as Frame;
}

async function seamWithSession(
  options: {
    limits?: Record<string, number>;
    deadline?: () => number | undefined;
    translator?: never;
    stream?: "deltas" | "never";
  } = {},
): Promise<{ seam: EngineSeam; session: ProbeSession }> {
  const seam = await engineSeam(
    options.limits === undefined ? {} : { options: { limits: options.limits } },
  );
  await seam.engine.ready();
  const session = await seam.probe.attachSession("t1", {
    translator: options.translator ?? translator(options.deadline),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  });
  return { seam, session };
}

/** A seam with one real stored thread: a live write publishes rows for a thread that exists. */
async function streamSeam(): Promise<{
  seam: EngineSeam;
  session: ProbeSession;
  threadId: ThreadId;
}> {
  const home = mkdtempSync(join(tmpdir(), "ace-actor-seam-"));
  let stored: ThreadId | undefined;
  const seam = await engineSeam({
    options: { home },
    seed: (store) => {
      const workspace = store.createWorkspace(home, "Actor seam");
      stored = createDevThread(store, workspace).id;
    },
  });
  await seam.engine.ready();
  if (stored === undefined) throw new Error("the seed created no thread");
  const session = await seam.probe.attachSession(stored, {
    translator: deltaTranslator(),
    stream: "deltas",
  });
  return { seam, session, threadId: stored };
}

/** An engine with no session: the actor-creation cases. */
async function bareSeam(options: { limits?: Record<string, number> } = {}): Promise<EngineSeam> {
  const seam = await engineSeam(
    options.limits === undefined ? {} : { options: { limits: options.limits } },
  );
  await seam.engine.ready();
  return seam;
}

/** Lets the pump's macrotasks run. Deterministic: no sleeps, only the event loop. */
async function tick(times = 16): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A promise's settlement, without leaving an unhandled rejection behind. */
function track(promise: Promise<void>): { done: boolean; error?: string } {
  const state: { done: boolean; error?: string } = { done: false };
  promise.then(
    () => {
      state.done = true;
    },
    (error: unknown) => {
      state.done = true;
      state.error = String((error as Error).message ?? error);
    },
  );
  return state;
}

/** The event payload types the store published, in order. */
function watchEvents(seam: EngineSeam): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const stop = seam.store.subscribe((events) => {
    for (const event of events) seen.push(event.payload.type);
  });
  return { seen, stop };
}

/** The stored event types for one thread, in sequence order. */
function storedTypes(seam: EngineSeam, threadId: ThreadId): string[] {
  const rows = seam.store.atomic(
    (db) =>
      db.prepare("SELECT type FROM events WHERE thread_id = ? ORDER BY seq").all(threadId) as {
        type?: unknown;
      }[],
  );
  return rows.map((row) => String(row.type));
}

/** The messages `onError` received, in order. */
function errors(seam: EngineSeam): string[] {
  return seam.ports.calls
    .filter((call) => call.port === "onError")
    .map((call) => String(call.args[0]));
}

/** Holds the store's write gate, so no op can run until `release`. */
function holdWrites(store: EngineSeam["store"]): { release(): Promise<void> } {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const maintenance = store.maintenance(async () => {
    await held;
  });
  return {
    async release() {
      open();
      await maintenance;
    },
  };
}

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
    const rollback = async (): Promise<void> => {
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
    };
    await rollback();
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
