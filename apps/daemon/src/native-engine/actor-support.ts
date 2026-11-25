// SPDX-License-Identifier: Apache-2.0
/**
 * The native actor's seam-test helpers, shared by `actor.test.ts`, `actor-lifetime.test.ts` and
 * `actor-live.test.ts`: a scripted session, a streamed one, frame constructors, ticks and holds.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { createDevThread } from "../commands.ts";
import { engineSeam, type EngineSeam, type ProbeSession } from "./testing.ts";

export const native = engineBackend() === "native";

/** A translator with no state: one signal fact per frame. */
export function translator(nextDeadline?: () => number | undefined) {
  return {
    translate: () => [{ type: "signal" }],
    tick: (now: number) => [{ type: "signal", agent: "root", t: now }],
    takeDiagnostics: () => [],
    ...(nextDeadline === undefined ? {} : { nextDeadline }),
  } as never;
}

/** A translator whose frames are established deltas, so `stream()` accepts them. */
export function deltaTranslator() {
  return {
    translate: () => [{ type: "item.delta", agent: "root", item: "i", field: "text", append: "x" }],
    tick: (now: number) => [{ type: "signal", agent: "root", t: now }],
    takeDiagnostics: () => [],
  } as never;
}

export function frame(seq: number, data: unknown = { type: "x" }): Frame {
  return { seq, t: seq, dir: "recv", channel: "stdio", data } as unknown as Frame;
}

export async function seamWithSession(
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
export async function streamSeam(): Promise<{
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
export async function bareSeam(
  options: { limits?: Record<string, number> } = {},
): Promise<EngineSeam> {
  const seam = await engineSeam(
    options.limits === undefined ? {} : { options: { limits: options.limits } },
  );
  await seam.engine.ready();
  return seam;
}

/** Lets the pump's macrotasks run. Deterministic: no sleeps, only the event loop. */
export async function tick(times = 16): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A promise's settlement, without leaving an unhandled rejection behind. */
export function track(promise: Promise<void>): { done: boolean; error?: string } {
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
export function watchEvents(seam: EngineSeam): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const stop = seam.store.subscribe((events) => {
    for (const event of events) seen.push(event.payload.type);
  });
  return { seen, stop };
}

/** The stored event types for one thread, in sequence order. */
export function storedTypes(seam: EngineSeam, threadId: ThreadId): string[] {
  const rows = seam.store.atomic(
    (db) =>
      db.prepare("SELECT type FROM events WHERE thread_id = ? ORDER BY seq").all(threadId) as {
        type?: unknown;
      }[],
  );
  return rows.map((row) => String(row.type));
}

/** The messages `onError` received, in order. */
export function errors(seam: EngineSeam): string[] {
  return seam.ports.calls
    .filter((call) => call.port === "onError")
    .map((call) => String(call.args[0]));
}

/** Holds the store's write gate, so no op can run until `release`. */
export function holdWrites(store: EngineSeam["store"]): { release(): Promise<void> } {
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
