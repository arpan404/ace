import type { StatementSync } from "node:sqlite";
import { z } from "zod";

/**
 * Removes event rows that a later `item.updated` for the same item fully replaces.
 *
 * `item.updated` carries the whole item and replaces it in every reader (the protocol calls it
 * authoritative), so the item's earlier `item.updated` and `item.delta` rows add nothing once it
 * exists. `item.created` stays: it fixes the item's place and creation time. Every row that
 * survives is unchanged.
 *
 * Only rows below a horizon are touched. The horizon trails the head by a day and by far more
 * than the live replay window, so a client resuming inside a pruned range always gets a fresh
 * snapshot (its cursor is either missing or too far behind). It also never passes a derived
 * index's cursor, so the indexes have already seen every row that is removed.
 */
export interface PruneHorizonOptions {
  now: number;
  /** Rows written within this long of `now` stay. */
  minAgeMs: number;
  /** Seqs kept behind the head; larger than any replay window a subscription accepts. */
  headMargin: number;
}
export const pruneDefaults = { minAgeMs: 86_400_000, headMargin: 65_536 } as const;

export interface PruneProgress {
  /** Every `item.updated` at or below this seq has been processed. */
  cursor: number;
  events: number;
  revisions: number;
}
export interface PruneBatch extends PruneProgress {
  /** No `item.updated` remains between the cursor and the horizon. */
  done: boolean;
}

const Seq = z.number().int().nonnegative();
const Progress = z.object({ cursor: Seq, events: Seq, revisions: Seq });
const Update = z.object({ seq: Seq, thread_id: z.string(), item_id: z.string().nullable() });
const Row = z.object({ seq: Seq });
const Cursor = z.object({ seq: Seq });
/** Prepared statements, cached by the caller. */
export type Sql = (text: string) => StatementSync;

export function initializeEventPruning(sql: Sql): void {
  sql(`CREATE TABLE IF NOT EXISTS storage_event_pruning(
    id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL,
    events INTEGER NOT NULL, revisions INTEGER NOT NULL)`).run();
  sql("INSERT OR IGNORE INTO storage_event_pruning VALUES(1,0,0,0)").run();
}

export function pruneProgress(sql: Sql): PruneProgress {
  return Progress.parse(
    sql("SELECT cursor,events,revisions FROM storage_event_pruning WHERE id=1").get(),
  );
}

const tableExists = (sql: Sql, name: string) =>
  sql("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

/** A derived index's replay cursor, or undefined when that index is not installed. */
function indexCursor(sql: Sql, table: string): number | undefined {
  if (!tableExists(sql, table)) return undefined;
  const row = sql(`SELECT seq FROM ${table} WHERE id=1`).get();
  return row ? Cursor.parse(row).seq : 0;
}

/** Largest seq whose event is older than `before`. Event times rise with seq, so bisect. */
function seqBefore(sql: Sql, before: number, head: number): number {
  const at = sql("SELECT seq,at FROM events WHERE seq>=? ORDER BY seq LIMIT 1");
  const time = (seq: number) => {
    const row = at.get(seq);
    return row ? z.object({ seq: Seq, at: z.number() }).parse(row) : undefined;
  };
  let low = 0;
  let high = head;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const found = time(middle);
    if (found && found.at < before) low = found.seq;
    else high = middle - 1;
  }
  return low;
}

/**
 * The exclusive upper bound for pruning. Zero while the long-thread range migration still
 * reads events by seq, and never past a derived index that has not caught up.
 */
export function pruneHorizon(sql: Sql, options: PruneHorizonOptions): number {
  if (tableExists(sql, "long_range_migration")) {
    const stage = sql("SELECT stage FROM long_range_migration WHERE id=1").get();
    if (stage && Number(stage.stage) !== 6) return 0;
  }
  const head = Cursor.parse(sql("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get()).seq;
  const bounds = [
    head - options.headMargin,
    seqBefore(sql, options.now - options.minAgeMs, head),
    indexCursor(sql, "long_meta"),
    indexCursor(sql, "search_meta"),
    indexCursor(sql, "search_full_meta"),
  ].filter((bound): bound is number => bound !== undefined);
  return Math.max(0, Math.min(...bounds));
}

export interface PruneBatchLimits {
  /** `item.updated` events handled per batch. */
  updates: number;
  /** Rows deleted per batch, so one item with thousands of deltas spans several batches. */
  deletions: number;
}

/**
 * Processes `item.updated` events after the cursor and below the horizon, in seq order, in the
 * caller's transaction. Invariant: once an update is processed, its item has no `item.updated`
 * or `item.delta` row before it. So for the next update only the rows since the item's
 * previous surviving update (or its creation) need looking at. An update whose rows exceed the
 * deletion budget keeps the cursor before it and continues in the next batch, oldest rows first.
 */
export function pruneBatch(sql: Sql, horizon: number, limits: PruneBatchLimits): PruneBatch {
  const progress = pruneProgress(sql);
  const scanRows = limits.updates * 64;
  // The row scan is bounded so a stretch without updates still ends the transaction quickly.
  const rows = sql(
    `SELECT seq,thread_id,CASE WHEN type='item.updated' AND json_valid(payload)
        THEN json_extract(payload,'$.item.id') END AS item_id,type='item.updated' AS updated
      FROM events WHERE seq>? AND seq<? ORDER BY seq LIMIT ?`,
  ).all(progress.cursor, horizon, scanRows);
  let cursor = progress.cursor;
  let processed = 0;
  let events = 0;
  let revisions = 0;
  let stopped = false;
  for (const raw of rows) {
    const row = Update.parse(raw);
    if (Number(raw.updated) === 1 && row.item_id !== null) {
      if (processed === limits.updates || events >= limits.deletions) {
        stopped = true;
        break;
      }
      processed++;
      const removed = supersede(
        sql,
        row.thread_id,
        row.item_id,
        row.seq,
        limits.deletions - events,
      );
      events += removed.events;
      revisions += removed.revisions;
      if (removed.more) {
        stopped = true;
        break;
      }
    }
    cursor = row.seq;
  }
  const done = !stopped && rows.length < scanRows;
  if (done) cursor = Math.max(cursor, horizon - 1);
  sql(
    "UPDATE storage_event_pruning SET cursor=?,events=events+?,revisions=revisions+? WHERE id=1",
  ).run(cursor, events, revisions);
  return {
    cursor,
    events: progress.events + events,
    revisions: progress.revisions + revisions,
    done,
  };
}

/**
 * Deletes what the update at `seq` replaces for its item. Candidates come from the item's own
 * indexes, not a scan of the thread: its revisions mark its updates, and the stream versions
 * of its text and output streams mark its deltas. Each candidate is checked against the event
 * row itself (CROSS JOIN keeps SQLite from scanning the thread instead). A delta without a
 * stream version is not found and simply stays.
 */
function supersede(sql: Sql, thread: string, item: string, seq: number, budget: number) {
  const since = previousSurvivor(sql, item, seq);
  if (since === undefined) return { events: 0, revisions: 0, more: false };
  const doomed = sql(
    `WITH streams(id) AS (
        SELECT id FROM item_text_streams WHERE item_id=?
        UNION SELECT id FROM output_streams WHERE item_id=?
      ), candidates(seq) AS (
        SELECT seq FROM history_item_revisions WHERE item_id=? AND seq>=? AND seq<?
        UNION SELECT v.seq FROM history_stream_versions v JOIN streams s ON s.id=v.stream_id
          WHERE v.seq>=? AND v.seq<?
      )
      SELECT e.seq FROM candidates c CROSS JOIN events e ON e.seq=c.seq
      WHERE e.thread_id=? AND e.type IN ('item.updated','item.delta') AND json_valid(e.payload)
        AND COALESCE(json_extract(e.payload,'$.item.id'),json_extract(e.payload,'$.itemId'))=?
      ORDER BY e.seq LIMIT ?`,
  )
    .all(item, item, item, since, seq, since, seq, thread, item, budget)
    .map((row) => Row.parse(row).seq);
  if (!doomed.length) return { events: 0, revisions: 0, more: false };
  // The first complete revision marks when the item finished; history reads cite it.
  const completed = sql(
    "SELECT MIN(seq) AS seq FROM history_item_revisions WHERE item_id=? AND json_extract(item,'$.complete')=1",
  ).get(item)?.seq;
  const dropEvent = sql("DELETE FROM events WHERE seq=?");
  const dropRevision = sql("DELETE FROM history_item_revisions WHERE item_id=? AND seq=?");
  let revisions = 0;
  for (const doomedSeq of doomed) {
    dropEvent.run(doomedSeq);
    if (doomedSeq !== completed) revisions += Number(dropRevision.run(item, doomedSeq).changes);
  }
  return { events: doomed.length, revisions, more: doomed.length === budget };
}

/**
 * The seq of the item's last surviving `item.created` or `item.updated` before `seq`. Older
 * rows were removed when that update was processed. Undefined when the item's creation is
 * unknown, which leaves the item alone.
 */
function previousSurvivor(sql: Sql, item: string, seq: number): number | undefined {
  const revision = sql(
    `SELECT r.seq FROM history_item_revisions r JOIN events e ON e.seq=r.seq
      WHERE r.item_id=? AND r.seq<? AND e.type IN ('item.created','item.updated')
      ORDER BY r.seq DESC LIMIT 1`,
  ).get(item, seq);
  if (revision) return Row.parse(revision).seq;
  const created = sql("SELECT created_seq AS seq FROM history_items WHERE id=?").get(item);
  return created ? Row.parse(created).seq : undefined;
}
