// SPDX-License-Identifier: Apache-2.0
//! Sequence allocation behind `ACE_STORE_WRITER=sequences` (phase 5.2b). A thin shell over
//! `ace_store::writer::sequences`: every method is one `nativeCall`, and the shell keeps no
//! cursor and no SQL of its own. `store.ts` hands this one instance to the event writer, the
//! live buffer and the tombstones, as it hands them the TypeScript one. The only state here is
//! the `StreamSequences` pending-range guard, which suppresses a duplicate refill in one outer
//! transaction and never counts as confirmation.

import { appendFileSync } from "node:fs";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { FailureReport, TransactionOutcome } from "../store-stream.ts";
import type { SequenceAllocator } from "../stream-sequences.ts";

/** The addon's `NativeSequences` (`native/daemon/crates/ace-daemon-node/src/writer.rs`). */
interface NativeSequences {
  reservedThrough(): number;
  head(): number;
  replaySafe(after: number): boolean;
  next(after: number): number;
  reservation(events: number, after: number): number | null;
  reserve(through: number): void;
  confirm(through: number): boolean;
  covers(seq: number): boolean;
}

/** The methods this shell uses on the addon's database handle. */
interface NativeStore {
  sequences(): NativeSequences;
}

function binding(db: DatabaseSync): NativeStore {
  const handle = nativeHandle(db as unknown as object) as unknown as NativeStore | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

/** The native allocator ran at least once in this process (the proof's evidence file). */
let evidenceWritten = false;

/** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native allocator, when set. */
function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_STORE_WRITER_EVIDENCE;
  if (path === undefined) return;
  evidenceWritten = true;
  appendFileSync(path, `${process.pid} sequences\n`);
}

export class NativeStreamSequences implements SequenceAllocator {
  private handle: NativeSequences | undefined;
  /** Ranges requested by transactions that have not settled yet; a rollback forgets them. */
  private pending: number[] = [];
  constructor(privateOptions: {
    /** The store's connection. The constructor stores it and touches neither SQL nor the addon. */
    db: DatabaseSync;
    /** Runs the reservation; settles only when the outermost transaction that wrote it does. */
    commit(run: () => void, outcome: TransactionOutcome): void;
    /** A range through `through` is reserved by a committed transaction and about to be used. */
    reserved?(through: number, report?: FailureReport): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  /** The first call into the addon: reads `host_sequence`, which only exists after `migrate`. */
  initialize(): void {
    this.handle = nativeCall(() => binding(this.options.db).sequences());
    this.pending = [];
    recordEvidence();
  }
  private ready(): NativeSequences {
    if (!this.handle) throw new Error("Sequences are not initialized");
    return this.handle;
  }
  reservedThrough(): number {
    return nativeCall(() => this.ready().reservedThrough());
  }
  head(): number {
    return nativeCall(() => this.ready().head());
  }
  replaySafe(after: number): boolean {
    return nativeCall(() => this.ready().replaySafe(after));
  }
  next(after: number): number {
    return nativeCall(() => this.ready().next(after));
  }
  prepare(events: number, after: number): void {
    const handle = this.ready();
    // A range already requested covers the batch even before its transaction commits, so a
    // second admission in the same outer transaction must not ask for another refill (and so
    // must not drain and seal the buffer). Pending ranges never count as confirmation.
    if (after + events <= this.provisional(handle)) return;
    const through = nativeCall(() => handle.reservation(events, after));
    if (through === null) return;
    this.pending.push(through);
    const settle = () => {
      const index = this.pending.indexOf(through);
      if (index >= 0) this.pending.splice(index, 1);
    };
    try {
      this.options.commit(() => nativeCall(() => handle.reserve(through)), {
        // Only the outermost commit counts: a rollback forgets the pending range, and the
        // cursor never moves back. Confirmation is monotonic across reentrant settlements.
        committed: (report) => {
          settle();
          if (nativeCall(() => handle.confirm(through))) this.options.reserved?.(through, report);
        },
        rolledBack: settle,
      });
    } catch (error) {
      settle();
      throw error;
    }
  }
  /** The highest sequence a confirmed or pending reservation holds. */
  private provisional(handle: NativeSequences): number {
    let limit = nativeCall(() => handle.reservedThrough());
    for (const through of this.pending)
      limit = Number.isNaN(limit) ? through : Math.max(limit, through);
    return limit;
  }
  covers(seq: number): boolean {
    return nativeCall(() => this.ready().covers(seq));
  }
}
