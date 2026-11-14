import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  storedEvent,
  storedItem,
  trustedFrom,
  untrusted,
  type StoredTrust,
} from "./stored-decode.ts";
import { recordStoredTrust, storedWriteGeneration, type OpenedTrust } from "./stored-shape.ts";
import { isStoreRetry } from "./store-busy.ts";
import { confirmThreadRows } from "./thread-row-trust.ts";

/**
 * The idle pass that lets rows an older build wrote regain the trusted read path (ADR 0125).
 *
 * After a shape change only rows this build writes are read as stored. While the daemon is idle
 * this pass walks the older history downwards from the trusted boundary, one bounded batch per
 * tick: for the events in the batch and every item, preview and history revision written at
 * their sequences, it reads the row both ways, validated and as stored, and keeps a sequence
 * trusted only when both give the same value, field order and size included. A sequence with a
 * row that differs, that validation rejects, or that is too large to check cheaply is rejected
 * and stays on the validating path, whichever of its rows caused it.
 *
 * Widening trust never changes what a read returns, so progress is kept in memory and saved
 * every `batchesPerSave` batches on a plain commit that wakes no cache, listener or WAL
 * maintenance; a restart repeats at most that many batches. Every batch first checks the write
 * generation (`stored-shape.ts`): when another build recorded a start, everything this build
 * trusted is dropped until it opens again. Thread rows not yet confirmed (`thread-row-trust.ts`)
 * are confirmed first, in small batches, instead of waiting for later opens.
 */

/** Events per batch at most. */
export const eventsPerBatch = 512;
/**
 * Bytes of stored JSON a batch checks at most, its events and the rows written at them
 * together: about 20 ms of CPU, so live work waits at most about that long.
 */
export const bytesPerBatch = 1 << 20;
/** A row larger than this is rejected unchecked: checking it would take one batch's budget. */
export const largestCheckedRow = bytesPerBatch;
/** Thread rows confirmed per batch. */
export const threadRowsPerBatch = 64;
/** Batches between saves of the pass's progress. */
export const batchesPerSave = 32;
/**
 * The pass stops extending trust once this many sequences are rejected: a schema change that
 * alters most old rows gains little from the pass, and every rejection is held in memory.
 */
export const rejectedLimit = 10_000;

type Row = Record<string, SQLOutputValue>;
const everything = trustedFrom(Number.NEGATIVE_INFINITY);
const nothing = untrusted();

/** Same value, same field order: what a trusted read gives equals what validation gives. */
function same(validated: unknown, stored: unknown): boolean {
  return (
    isDeepStrictEqual(validated, stored) && JSON.stringify(validated) === JSON.stringify(stored)
  );
}
function sameEvent(row: Row): boolean {
  try {
    const validated = storedEvent(row, nothing);
    const stored = storedEvent(row, everything);
    return validated.bytes === stored.bytes && same(validated.event, stored.event);
  } catch {
    return false;
  }
}
function sameItem(seq: number, json: string): boolean {
  try {
    return same(storedItem(seq, json, nothing), storedItem(seq, json, everything));
  } catch {
    return false;
  }
}

/** The ids of the items an event's revisions are kept under; never throws on malformed JSON. */
const revisedItems = `CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.item.id') END,
  CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.itemId') END`;
const size = (column: string) => `length(CAST(${column} AS BLOB))`;

/** The stored JSON at each event's sequence, newest first: what a batch's budget counts. */
const sizesBelow = `SELECT e.seq, ${size("e.payload")}
  + COALESCE((SELECT ${size("i.item")} + COALESCE((SELECT ${size("p.item")} FROM item_previews p WHERE p.id = i.id), 0)
      FROM items i WHERE i.created_seq = e.seq), 0)
  + COALESCE((SELECT SUM(${size("r.item")}) FROM history_item_revisions r
      WHERE r.seq = e.seq AND r.item_id IN (${revisedItems})), 0) AS bytes
  FROM events e WHERE e.seq < ? ORDER BY e.seq DESC LIMIT ?`;

/**
 * Item bodies read by the sequence they were written at, in [low, high): items and their text
 * previews by the item's creation, history revisions by their own sequence (written with the
 * event at it, for the item that event names). `body` is the column checked.
 */
const writtenAt = [
  {
    body: "i.item",
    from: "items i WHERE i.created_seq >= ? AND i.created_seq < ?",
    seq: "i.created_seq",
  },
  {
    body: "p.item",
    from: "items i JOIN item_previews p ON p.id = i.id WHERE i.created_seq >= ? AND i.created_seq < ?",
    seq: "i.created_seq",
  },
  {
    body: "r.item",
    from: `events e JOIN history_item_revisions r ON r.seq = e.seq AND r.item_id IN (${revisedItems}) WHERE e.seq >= ? AND e.seq < ?`,
    seq: "r.seq",
  },
];

/** One batch's outcome: every sequence from `from` on is confirmed, except `rejected`. */
export interface StoredTrustBatch {
  from: number;
  rejected: number[];
}

/**
 * Check the events just below `trust.from`, as many as fit `bytes` (at least one), and the
 * rows written at their sequences. Reads only. Returns undefined when nothing is left.
 */
export function verifyStoredBatch(
  db: DatabaseSync,
  trust: StoredTrust,
  limit = eventsPerBatch,
  bytes = bytesPerBatch,
): StoredTrustBatch | undefined {
  const high = trust.from;
  if (!(high > 0)) return undefined;
  const sizes = db.prepare(sizesBelow).all(high, limit);
  let low = 0;
  let total = 0;
  let taken = 0;
  for (const row of sizes) {
    const rowBytes = Number(row.bytes);
    if (taken > 0 && total + rowBytes > bytes) break;
    total += rowBytes;
    taken++;
    low = Number(row.seq);
  }
  // A short page that fit whole reached the oldest event; the batch covers every older sequence.
  if (taken === sizes.length && sizes.length < limit) low = 0;
  const rejected = new Set<number>();
  const oversized = (from: string, body: string, seq: string) =>
    db.prepare(`SELECT ${seq} AS seq FROM ${from} AND ${size(body)} > ?`);
  for (const row of oversized("events e WHERE e.seq >= ? AND e.seq < ?", "e.payload", "e.seq").all(
    low,
    high,
    largestCheckedRow,
  ))
    rejected.add(Number(row.seq));
  for (const row of db
    .prepare(
      `SELECT seq, id, thread_id, at, payload FROM events WHERE seq >= ? AND seq < ? AND ${size("payload")} <= ?`,
    )
    .iterate(low, high, largestCheckedRow))
    if (!sameEvent(row)) rejected.add(Number(row.seq));
  for (const source of writtenAt) {
    for (const row of oversized(source.from, source.body, source.seq).all(
      low,
      high,
      largestCheckedRow,
    ))
      rejected.add(Number(row.seq));
    for (const row of db
      .prepare(
        `SELECT ${source.seq} AS seq, ${source.body} AS item FROM ${source.from} AND ${size(source.body)} <= ?`,
      )
      .iterate(low, high, largestCheckedRow)) {
      const seq = Number(row.seq);
      if (!rejected.has(seq) && !sameItem(seq, String(row.item))) rejected.add(seq);
    }
  }
  return { from: low, rejected: [...rejected] };
}

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
  /** Runs `run` in a plain write transaction that wakes nothing that watches the store. */
  commit: <T>(run: (db: DatabaseSync) => T) => T;
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
    const saved = options.commit((tx) =>
      recordStoredTrust(tx, options.shape, options.opened, pending.from, pending.rejected),
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
      if (options.commit((tx) => confirmThreadRows(tx, threadRowsPerBatch)) > 0) return true;
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

/** A plain write transaction on `db`, for a caller that knows none is open. */
export function plainCommit(db: DatabaseSync): <T>(run: (db: DatabaseSync) => T) => T {
  return (run) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}
