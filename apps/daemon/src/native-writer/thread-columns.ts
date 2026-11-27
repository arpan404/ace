// SPDX-License-Identifier: Apache-2.0
//! The thread column writes behind `ACE_STORE_WRITER=columns` (task 5.3b-2): `writeThread`
//! through its revision read, one `nativeCall` into `ace_store::writer::thread_columns`.
//! `rebuildThread`, the trust stamp and the `remember*` calls stay in `event-writer.ts`.
//!
//! Zod's parse of the previous details a cold upsert rebinds runs here, with the schema the
//! TypeScript path uses (`ThreadDetails.parse`), never a Rust copy of it: that value leaves
//! the shape table's reach, and two validators would drift apart.

import { appendFileSync } from "node:fs";
import { ThreadDetails, type Thread } from "@ace/protocol";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { ColumnValue, ThreadColumn } from "../thread-columns.ts";
import type { ThreadPart } from "../thread-row.ts";
import type { FrozenThread } from "../thread-cache.ts";

/** What a thread write stored, for `rebuildThread`. */
export interface ColumnsWritten {
  row: Record<string, ColumnValue>;
  parts: Set<ThreadPart>;
  confirmed: boolean;
  revision: number | undefined;
}

/** The addon's `NativeThreadColumnWriter` (`native/daemon/crates/ace-daemon-node/src/writer.rs`). */
interface NativeThreadColumnWriter {
  /** Null when no column changed; else the written row as JSON text. */
  write(previous: string | null, next: string, wanted: readonly string[]): string | null;
}

interface NativeStore {
  threadColumnWriter(): NativeThreadColumnWriter;
}

/** One writer per connection: it holds the prepared statements. */
const writers = new WeakMap<DatabaseSync, NativeThreadColumnWriter>();

function writer(db: DatabaseSync): NativeThreadColumnWriter {
  const cached = writers.get(db);
  if (cached) return cached;
  const handle = nativeHandle(db as unknown as object) as unknown as NativeStore | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  const created = nativeCall(() => handle.threadColumnWriter());
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
  appendFileSync(path, `${process.pid} columns\n`);
}

/** The addon's parsed result: `revision` is null when the row has no number. */
interface StoredColumns {
  row: Record<string, ColumnValue>;
  parts: ThreadPart[];
  confirmed: boolean;
  revision: number | null;
}

/**
 * Store what this event changed in the thread's columns, and nothing when it changed none.
 * `previous` is what the row decoded to before (none on creation).
 */
export function writeThreadColumns(
  db: DatabaseSync,
  previous: FrozenThread | undefined,
  thread: Thread,
  wanted: readonly ThreadColumn[],
): ColumnsWritten | undefined {
  const result = nativeCall(() =>
    writer(db).write(
      previous === undefined ? null : JSON.stringify(previous),
      JSON.stringify(thread),
      wanted,
    ),
  );
  recordEvidence();
  if (result === null) return undefined;
  const stored = JSON.parse(result) as StoredColumns;
  const parts = new Set(stored.parts);
  // `writeColumns` builds the cold upsert's bind values with `coldRowValues`, which parses the
  // previous details it rebinds: a stored value Zod rejects throws there and the append rolls
  // back. The upsert ran with `previous`'s details exactly when `capabilities` changed and
  // `details` did not, so the same parse runs here, in the caller's transaction. The writer
  // already reports the changed parts, so no comparison is repeated, and `previous` holds the
  // details it read (no statement).
  if (previous?.details !== undefined && parts.has("capabilities") && !parts.has("details"))
    ThreadDetails.parse(previous.details);
  return {
    row: stored.row,
    parts,
    confirmed: stored.confirmed,
    revision: stored.revision ?? undefined,
  };
}
