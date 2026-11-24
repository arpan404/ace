// SPDX-License-Identifier: Apache-2.0
//! The live buffer's pure parts behind `ACE_STORE_WRITER=live` (phase 5.4a). Delta compaction
//! and the retry delay come from `ace_store::writer::live`; the buffer's bookkeeping, the
//! 75 ms and 1 s deadlines, and the timer that arms them stay TypeScript until 5.4b.

import { appendFileSync } from "node:fs";
import { storeWriterOn } from "@ace/provider-kit/native-switches";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Event } from "@ace/protocol";
import { compactDeltas as compactDeltasTypeScript } from "../live-write-buffer.ts";
import { liveWriteRetryDelay } from "../live-write-retry.ts";

/** The addon's live methods on its database handle (`native/daemon/.../writer.rs`). */
interface NativeLive {
  /** Events as JSON text in; the compacted rows as JSON text out. */
  compactDeltas(events: string): string;
  /** The `failures`-th failure's delay in ms: a deadline, never a timer here. */
  liveRetryDelay(failures: number): number;
}

function binding(db: DatabaseSync): NativeLive {
  const handle = nativeHandle(db as unknown as object) as unknown as NativeLive | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

/** The native live part ran at least once in this process (the proof's evidence file). */
let evidenceWritten = false;

/** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native live call, when set. */
function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_STORE_WRITER_EVIDENCE;
  if (path === undefined) return;
  evidenceWritten = true;
  appendFileSync(path, `${process.pid} live\n`);
}

/** `compactDeltas` with the switch off; with it on, the Rust compaction. */
export function compactDeltas(db: DatabaseSync, events: Event[]): Event[] {
  if (!storeWriterOn("live")) return compactDeltasTypeScript(events);
  recordEvidence();
  const text = nativeCall(() => binding(db).compactDeltas(JSON.stringify(events)));
  return JSON.parse(text) as Event[];
}

/** `liveWriteRetryDelay` with the switch off; with it on, the Rust rule. */
export function retryDelay(db: DatabaseSync, failures: number): number {
  if (!storeWriterOn("live")) return liveWriteRetryDelay(failures);
  recordEvidence();
  return nativeCall(() => binding(db).liveRetryDelay(failures));
}
