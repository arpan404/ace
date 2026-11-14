import type { DatabaseSync } from "node:sqlite";
import type { StoredTrust } from "./stored-decode.ts";
import { storedWriteGeneration, type OpenedTrust } from "./stored-shape.ts";
import { isStoreRetry } from "./store-busy.ts";
import { verifyStoredBatch } from "./stored-trust-batch.ts";
import type { TrustTableWrites } from "./stored-trust-writes.ts";

/**
 * The idle pass that lets rows an older build wrote regain the trusted read path (ADR 0125).
 *
 * After a shape change only rows this build writes are read as stored. While the daemon is idle
 * this pass walks the older history downwards from the trusted boundary, one bounded batch per
 * tick (`stored-trust-batch.ts`): a sequence becomes trusted only when every row written at it
 * reads the same as stored as validated, and any other sequence stays on the validating path.
 *
 * Widening trust never changes what a read returns, so progress is kept in memory and saved
 * every `batchesPerSave` batches through a trust-table write that changes no thread read; a restart
 * repeats at most that many batches. Every batch first checks the write generation
 * (`stored-shape.ts`): when another build recorded a start, everything this build trusted is
 * dropped until it opens again. Once the pass finishes nothing watches the generation: one
 * daemon owns a data directory (`acquireLock`), so a second writer of another build while this
 * one runs is unsupported. Thread rows not yet confirmed (`thread-row-trust.ts`) are confirmed
 * first, in small batches, instead of waiting for later opens.
 */

/** Thread rows confirmed per batch. */
export const threadRowsPerBatch = 64;
/** Batches between saves of the pass's progress. */
export const batchesPerSave = 32;
/**
 * The pass stops extending trust once this many sequences are rejected: a schema change that
 * alters most old rows gains little from the pass, and every rejection is held in memory.
 */
export const rejectedLimit = 100_000;

/** Threads with a run in progress: an agent working or waiting on its own work. */
export function runInProgress(db: DatabaseSync): boolean {
  // Matches the `threads_update_blockers` partial index's condition so the index serves it.
  return (
    db
      .prepare(
        "SELECT 1 FROM threads WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed') AND json_extract(status, '$.state') IN ('working', 'waiting') LIMIT 1",
      )
      .get() !== undefined
  );
}

/** A repeating callback and its cancellation, like the search writer's scheduler. */
export type TrustPassScheduler = (tick: () => void) => () => void;
export function scheduleTrustPass(tick: () => void): () => void {
  const timer = setInterval(tick, 200);
  timer.unref();
  return () => clearInterval(timer);
}

export interface StoredTrustPassOptions {
  scheduler: TrustPassScheduler;
  db: DatabaseSync;
  /** The pass's only writes, each to trust tables only (`stored-trust-writes.ts`). */
  writes: TrustTableWrites;
  shape: string;
  opened: OpenedTrust;
  trust: StoredTrust;
  /** Whether live work is in flight: a run, a transaction, a history write, buffered output. */
  busy: () => boolean;
  /** The newest sequence; the pass only runs on ticks where it hasn't moved since the last. */
  headSeq: () => number;
  report: (error: unknown) => void;
  rejectedLimit?: number | undefined;
  batchesPerSave?: number | undefined;
}

/**
 * Run the pass, one batch per idle tick: a tick does work only when nothing is busy and no
 * event was written since the previous tick. Stops when nothing is left or the rejection limit
 * is reached; a busy database retries on a later tick; any other error stops the pass and is
 * reported. `close` saves what is not saved yet.
 */
export function startStoredTrustPass(options: StoredTrustPassOptions): { close(): void } {
  const { db, trust } = options;
  const limit = options.rejectedLimit ?? rejectedLimit;
  const saveEvery = options.batchesPerSave ?? batchesPerSave;
  let head = options.headSeq();
  let threadsDone = false;
  let unsaved: { from: number; rejected: number[] } | undefined;
  let sinceSave = 0;
  let stop: (() => void) | undefined;
  const finish = () => {
    const cancel = stop;
    stop = undefined;
    cancel?.();
  };
  /** Another build recorded a start: nothing this build trusted can be relied on any more. */
  const invalidate = () => {
    trust.from = Number.POSITIVE_INFINITY;
    trust.rejected.clear();
    unsaved = undefined;
    finish();
  };
  const save = () => {
    const pending = unsaved;
    if (!pending) return;
    const saved = options.writes.saveProgress(
      options.shape,
      options.opened,
      pending.from,
      pending.rejected,
    );
    unsaved = undefined;
    sinceSave = 0;
    if (!saved) invalidate();
  };
  const batch = (): boolean => {
    if (storedWriteGeneration(db) !== options.opened.generation) {
      invalidate();
      return false;
    }
    if (!threadsDone) {
      if (options.writes.stampThreadRows(threadRowsPerBatch) > 0) return true;
      threadsDone = true;
    }
    const done = verifyStoredBatch(db, trust);
    if (!done || trust.rejected.size + done.rejected.length > limit) {
      save();
      return false;
    }
    for (const seq of done.rejected) trust.rejected.add(seq);
    trust.from = done.from;
    unsaved = { from: done.from, rejected: [...(unsaved?.rejected ?? []), ...done.rejected] };
    if (++sinceSave >= saveEvery) save();
    return true;
  };
  const tick = () => {
    const now = options.headSeq();
    const quiet = now === head;
    head = now;
    if (!quiet || options.busy()) return;
    try {
      if (!batch()) finish();
    } catch (error) {
      if (isStoreRetry(error)) return;
      finish();
      options.report(error);
    }
  };
  stop = options.scheduler(tick);
  return {
    close() {
      finish();
      try {
        if (!db.isTransaction) save();
      } catch (error) {
        // Unsaved progress is only repeated by the next pass.
        if (!isStoreRetry(error)) options.report(error);
      }
    },
  };
}
