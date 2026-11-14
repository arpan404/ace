import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  storedEvent,
  storedItem,
  trustedFrom,
  untrusted,
  type StoredTrust,
} from "./stored-decode.ts";
import { recordStoredTrust } from "./stored-shape.ts";
import { isStoreRetry } from "./store-busy.ts";
import { confirmThreadRows } from "./thread-row-trust.ts";

/**
 * The idle pass that lets rows an older build wrote regain the trusted read path (ADR 0125).
 *
 * After a shape change only rows this build writes are read as stored. While the daemon is idle
 * this pass walks the older history downwards from the trusted boundary, a bounded batch at a
 * time: for the events in the batch and every item, preview and history revision written at
 * their sequences, it reads the row both ways, validated and as stored, and keeps a sequence
 * trusted only when both give the same value, field order and size included. A sequence with a
 * row that differs, or that validation rejects, is recorded as rejected and stays on the
 * validating path. Each batch commits its new boundary and rejections with the reads, so an
 * interrupted pass resumes where it stopped. Thread rows not yet confirmed (`thread-row-trust.ts`)
 * are confirmed first, in small batches, instead of waiting for later opens.
 */

/** Events per batch: a few milliseconds of CPU, so a read or write waits at most that long. */
export const eventsPerBatch = 512;
/** Thread rows confirmed per batch. */
export const threadRowsPerBatch = 64;
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

/**
 * Item bodies read by the sequence they were written at, in [low, high): items and their text
 * previews by the item's creation, history revisions by their own sequence (written with the
 * event at it, for the item that event names).
 */
const writtenAt = [
  "SELECT created_seq AS seq, item FROM items WHERE created_seq >= ? AND created_seq < ?",
  "SELECT i.created_seq AS seq, p.item FROM items i JOIN item_previews p ON p.id = i.id WHERE i.created_seq >= ? AND i.created_seq < ?",
  "SELECT r.seq, r.item FROM events e JOIN history_item_revisions r ON r.seq = e.seq AND r.item_id IN (json_extract(e.payload, '$.item.id'), json_extract(e.payload, '$.itemId')) WHERE e.seq >= ? AND e.seq < ?",
];

/** One batch's outcome: every sequence from `from` on is confirmed, except `rejected`. */
export interface StoredTrustBatch {
  from: number;
  rejected: number[];
}

/**
 * Check the events just below `trust.from` and the rows written at their sequences, and record
 * the result for `shape`. Run in one transaction. Returns undefined when nothing is left to
 * check, or the rejections would pass `rejectedLimit`.
 */
export function verifyStoredBatch(
  db: DatabaseSync,
  shape: string,
  trust: StoredTrust,
  limit = eventsPerBatch,
): StoredTrustBatch | undefined {
  const high = trust.from;
  if (!(high > 0) || trust.rejected.size >= rejectedLimit) return undefined;
  const events = db
    .prepare(
      "SELECT seq, id, thread_id, at, payload FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?",
    )
    .all(high, limit);
  const last = events.at(-1);
  // A short page reached the oldest event; the batch then covers every older sequence too.
  const low = events.length < limit || !last ? 0 : Number(last.seq);
  const rejected = new Set<number>();
  for (const row of events) if (!sameEvent(row)) rejected.add(Number(row.seq));
  for (const sql of writtenAt)
    for (const row of db.prepare(sql).iterate(low, high)) {
      const seq = Number(row.seq);
      if (!rejected.has(seq) && !sameItem(seq, String(row.item))) rejected.add(seq);
    }
  if (trust.rejected.size + rejected.size > rejectedLimit) return undefined;
  const batch = { from: low, rejected: [...rejected] };
  recordStoredTrust(db, shape, batch.from, batch.rejected);
  return batch;
}

/** Widen the in-memory trust by a committed batch. */
export function applyStoredBatch(trust: StoredTrust, batch: StoredTrustBatch): void {
  for (const seq of batch.rejected) trust.rejected.add(seq);
  trust.from = batch.from;
}

/** A repeating callback and its cancellation, like the search writer's scheduler. */
export type TrustPassScheduler = (tick: () => void) => () => void;
export function scheduleTrustPass(tick: () => void): () => void {
  const timer = setInterval(tick, 250);
  timer.unref();
  return () => clearInterval(timer);
}

export interface StoredTrustPassOptions {
  scheduler: TrustPassScheduler;
  /** Runs a function in one write transaction. */
  atomic: <T>(run: (db: DatabaseSync) => T) => T;
  shape: string;
  trust: StoredTrust;
  /** Whether live work is in flight: a transaction, a history write, buffered stream output. */
  busy: () => boolean;
  /** The newest sequence; the pass only runs on ticks where it hasn't moved since the last. */
  headSeq: () => number;
  report: (error: unknown) => void;
  batchesPerTick?: number | undefined;
}

/**
 * Run the pass on idle ticks: a tick does work only when nothing is busy and no event was
 * written since the previous tick, and checks again before each batch. Stops when nothing is
 * left; a busy database retries on a later tick, any other error stops the pass and is reported.
 */
export function startStoredTrustPass(options: StoredTrustPassOptions): { close(): void } {
  const perTick = options.batchesPerTick ?? 2;
  let head = options.headSeq();
  let threadsDone = false;
  let stop: (() => void) | undefined;
  const finish = () => {
    const cancel = stop;
    stop = undefined;
    cancel?.();
  };
  const batch = (): boolean => {
    if (!threadsDone) {
      if (options.atomic((db) => confirmThreadRows(db, threadRowsPerBatch)) > 0) return true;
      threadsDone = true;
    }
    const done = options.atomic((db) => verifyStoredBatch(db, options.shape, options.trust));
    if (!done) return false;
    applyStoredBatch(options.trust, done);
    return true;
  };
  const tick = () => {
    const now = options.headSeq();
    const quiet = now === head;
    head = now;
    if (!quiet) return;
    try {
      for (let index = 0; index < perTick; index++) {
        if (options.busy() || options.headSeq() !== head) return;
        if (!batch()) return finish();
      }
    } catch (error) {
      if (isStoreRetry(error)) return;
      finish();
      options.report(error);
    }
  };
  stop = options.scheduler(tick);
  return { close: finish };
}
