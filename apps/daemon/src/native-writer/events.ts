// SPDX-License-Identifier: Apache-2.0
//! The event writer's own rows behind `ACE_STORE_WRITER=events` (phase 5.3a). Two calls,
//! each one `nativeCall` into `ace_store::writer::events`: a new thread's row and one event
//! row with the high-water mark. The loop, the `Invalid thread creation` and `Unknown
//! thread` checks stay in `event-writer.ts`.

import { appendFileSync } from "node:fs";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";

/** The addon's `NativeEventWriter` (`native/daemon/crates/ace-daemon-node/src/writer.rs`). */
interface NativeEventWriter {
  createThread(
    id: string,
    workspaceId: string,
    title: string,
    provider: string,
    statusJson: string,
    createdAt: number,
    updatedAt: number,
    importedJson: string | null,
    imported: boolean,
  ): void;
  storeEvent(
    seq: number,
    id: string,
    threadId: string,
    at: number,
    kind: string,
    payloadJson: string,
  ): void;
}

/** The method this shell uses on the addon's database handle. */
interface NativeStore {
  eventWriter(): NativeEventWriter;
}

/**
 * One writer per connection: it holds the prepared statements, so a fresh one per append
 * would prepare the same five statements again.
 */
const writers = new WeakMap<DatabaseSync, NativeEventWriter>();

function writer(db: DatabaseSync): NativeEventWriter {
  const cached = writers.get(db);
  if (cached) return cached;
  const handle = nativeHandle(db as unknown as object) as unknown as NativeStore | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  const created = nativeCall(() => handle.eventWriter());
  writers.set(db, created);
  return created;
}

/** The native writer ran at least once in this process (the proof's evidence file). */
let evidenceWritten = false;

/** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native write, when set. */
function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_STORE_WRITER_EVIDENCE;
  if (path === undefined) return;
  evidenceWritten = true;
  appendFileSync(path, `${process.pid} events\n`);
}

/** A new thread's `threads` row, its `workspace_recent` entry unless imported. */
export interface NewThreadRow {
  id: string;
  workspaceId: string;
  title: string;
  provider: string;
  /** `JSON.stringify(thread.status)`. */
  statusJson: string;
  createdAt: number;
  /** The append's `at`, which the TypeScript stores as `updated_at`. */
  updatedAt: number;
  /** `JSON.stringify(thread.imported)`, or null for NULL. */
  importedJson: string | null;
  /** `Boolean(thread.imported)`: an imported thread started nothing now. */
  imported: boolean;
}

/** One event row and the high-water mark it moves. */
export interface EventRow {
  seq: number;
  id: string;
  threadId: string;
  /** The append's `at`, not `event.at`. */
  at: number;
  kind: string;
  /** `JSON.stringify(event.payload)` after capping, stored as given. */
  payloadJson: string;
}

export function createThread(db: DatabaseSync, row: NewThreadRow): void {
  recordEvidence();
  nativeCall(() =>
    writer(db).createThread(
      row.id,
      row.workspaceId,
      row.title,
      row.provider,
      row.statusJson,
      row.createdAt,
      row.updatedAt,
      row.importedJson,
      row.imported,
    ),
  );
}

export function storeEvent(db: DatabaseSync, row: EventRow): void {
  recordEvidence();
  nativeCall(() =>
    writer(db).storeEvent(row.seq, row.id, row.threadId, row.at, row.kind, row.payloadJson),
  );
}
