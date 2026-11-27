// SPDX-License-Identifier: Apache-2.0
//! The projection fold behind `ACE_STORE_WRITER=fold` (phase 5.1). `foldInput` is what
//! crosses for an event; `foldThread` is `updateThread` with the switch off and the native
//! fold with it on, applied in place.

import { appendFileSync } from "node:fs";
import { updateThread } from "@ace/projection";
import { storeWriterOn } from "@ace/provider-kit/native-switches";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Event, Thread } from "@ace/protocol";

interface NativeFold {
  foldThread(thread: string, kind: string, seq: number, at: number, payload: string | null): string;
}

function binding(db: DatabaseSync): NativeFold {
  const handle = nativeHandle(db as unknown as object) as unknown as NativeFold | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

/** What crosses for this event, or undefined when the fold reads nothing of it. */
export function foldInput(event: Event): { kind: string; payload: string | null } | undefined {
  const type = event.payload.type;
  if (type === "queue.updated") return { kind: type, payload: JSON.stringify(event.payload) };
  if (type === "thread.client.updated")
    return { kind: type, payload: JSON.stringify(event.payload) };
  if (type === "thread.updated") return { kind: type, payload: JSON.stringify(event.payload) };
  if (type === "thread.created") return { kind: type, payload: null };
  if (type === "agent.created" && event.payload.agent.origin === "root")
    return { kind: type, payload: JSON.stringify(event.payload.agent.id) };
  return undefined;
}

/** The native fold ran at least once in this process (the proof's evidence file). */
let evidenceWritten = false;

/** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native fold, when set. */
function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_STORE_WRITER_EVIDENCE;
  if (path === undefined) return;
  evidenceWritten = true;
  appendFileSync(path, `${process.pid} fold\n`);
}

/** updateThread with the switch off; with it on, the native fold, applied in place. */
export function foldThread(db: DatabaseSync, thread: Thread, event: Event): void {
  if (!storeWriterOn("fold")) {
    updateThread(thread, event);
    return;
  }
  const input = foldInput(event);
  if (input === undefined) return;
  const text = nativeCall(() =>
    binding(db).foldThread(JSON.stringify(thread), input.kind, event.seq, event.at, input.payload),
  );
  const next = JSON.parse(text) as Record<string, unknown>;
  recordEvidence();
  for (const key of Object.keys(thread)) Reflect.deleteProperty(thread, key);
  for (const [key, value] of Object.entries(next))
    Object.defineProperty(thread, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}
