import type { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import type { ThreadId } from "@ace/protocol";

/** These rows contain transcript data; identity/receipt/delegation/worktree ownership stays durable. */
const payloadTables = new Set([
  "items",
  "output_streams",
  "blobs",
  "history_blobs",
  "streamed_blobs",
  "view_entities",
  "native_images",
  "measurement_tools",
  "step_measurements",
  "ace_result_images",
  "ace_results",
  "ace_tools",
  "engine_provider_frames",
  "engine_state_appends",
  "engine_state_records",
  "engine_attachment_correlations",
  "engine_queue_attachments",
  "engine_inputs",
  "engine_input_echoes",
  "engine_input_messages",
  "engine_admitted_attachments",
  // Messages from other machines held while admission was closed (`machines/held-messages.ts`).
  "machine_held_messages",
]);
/**
 * The engine's own rows for the thread: its session, selection and queue. Without its state
 * they only lead a reader to a thread it can no longer load (ADR 0177), so a purge removes them.
 */
const engineRows = [
  "engine_sessions",
  "engine_transitions",
  "engine_transition_guards",
  "engine_queue",
];
function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .flatMap((row) =>
      typeof row.name === "string" &&
      (payloadTables.has(row.name) || /^long_[a-z_]+$/.test(row.name)) &&
      db
        .prepare(`PRAGMA table_info("${row.name}")`)
        .all()
        .some((column) => column.name === "thread_id")
        ? [row.name]
        : [],
    );
}

/**
 * The statements that sum one thread's transcript bytes, each bound to the thread id. Read the
 * schema once per inventory, not once per thread. `octet_length` reads record headers only, so
 * no payload is materialized.
 */
export function transcriptQueries(db: DatabaseSync): string[] {
  const queries = [
    "SELECT COALESCE(SUM(octet_length(payload)),0) AS bytes FROM events WHERE thread_id=?",
  ];
  for (const table of tables(db)) {
    const columns = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .flatMap((column) =>
        typeof column.name === "string" && /^[a-z_]+$/.test(column.name) ? [column.name] : [],
      );
    if (!columns.length) continue;
    const expression = columns.map((name) => `COALESCE(octet_length("${name}"),0)`).join("+");
    queries.push(
      `SELECT COALESCE(SUM(${expression}),0) AS bytes FROM "${table}" WHERE thread_id=?`,
    );
  }
  // Chunk ownership is indirect. Their byte metadata does not materialize large payloads.
  for (const [chunks, streams, key] of [
    ["output_chunks", "output_streams", "stream_id"],
    ["item_source_chunks", "item_text_streams", "stream_id"],
    ["history_blob_chunks", "history_blobs", "blob_id"],
    ["streamed_blob_chunks", "streamed_blobs", "blob_id"],
  ])
    queries.push(
      `SELECT COALESCE(SUM(octet_length(c.bytes)),0) AS bytes FROM ${chunks} c JOIN ${streams} s ON c.${key}=s.id WHERE s.thread_id=?`,
    );
  return queries;
}

/**
 * One thread's transcript bytes. Each statement covers only this thread's rows, and the loop
 * yields between statements, so a thread with a very long history never holds the event loop
 * for its whole measurement. `undefined` once `going` turns false: shutdown never waits for the
 * rest of a measurement.
 */
export async function transcriptBytes(
  read: (sql: string) => StatementSync,
  id: ThreadId,
  queries: readonly string[],
  going: () => boolean = () => true,
): Promise<number | undefined> {
  let bytes = 0;
  for (const sql of queries) {
    await setImmediate();
    if (!going()) return undefined;
    bytes += Number(read(sql).get(id)?.bytes);
  }
  return bytes;
}

function requireDeleted(db: DatabaseSync, id: ThreadId): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM threads WHERE id=? AND json_extract(client,'$.deletedAt') IS NOT NULL",
      )
      .get(id)
  )
    throw new Error("thread_not_deleted");
}

/** One table a purge empties, and the key its batches select rows by. */
export interface PurgeStep {
  table: string;
  key: string;
}

/**
 * The tables a purge empties, in order: referencing rows before the records they name (chunks go
 * with their items through the existing FK cascades), then the events. Read once per purge.
 */
export function transcriptPurgePlan(db: DatabaseSync): PurgeStep[] {
  const selected = tables(db);
  const records = ["items", "ace_results", "ace_tools"];
  return [
    ...selected.filter((name) => !records.includes(name)),
    ...records.filter((name) => selected.includes(name)),
    "events",
  ].map((table) => ({ table, key: rowKey(db, table) }));
}
/** `rowid`, or the primary key's columns for a table without one. */
function rowKey(db: DatabaseSync, table: string): string {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!String(sql?.sql ?? "").includes("WITHOUT ROWID")) return "rowid";
  const columns = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .filter((column) => Number(column.pk) > 0)
    .toSorted((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => `"${String(column.name)}"`);
  return `(${columns.join(",")})`;
}

/**
 * Deletes at most `limit` of a deleted thread's transcript rows, from the first table in `plan`
 * that still has any, through its `thread_id` index; 0 once none are left. Each call is one short
 * write, so a large thread is purged a batch at a time (ADR 0170, 0177).
 */
export function purgeTranscriptBatch(
  db: DatabaseSync,
  id: ThreadId,
  plan: readonly PurgeStep[],
  limit: number,
): number {
  requireDeleted(db, id);
  for (const { table, key } of plan) {
    const columns = key === "rowid" ? key : key.slice(1, -1);
    const deleted = Number(
      db
        .prepare(
          `DELETE FROM "${table}" WHERE ${key} IN (SELECT ${columns} FROM "${table}" WHERE thread_id=? LIMIT ?)`,
        )
        .run(id, limit).changes,
    );
    if (deleted > 0) return deleted;
  }
  return 0;
}

/**
 * The purge's last, small step: whatever is left of the transcript (nothing, after the batches),
 * the thread's finished intents, its engine state and the engine's own rows. Caller has
 * committed a tombstone and stopped the idle engine owner before entering SQLite.
 */
export function purgeTranscript(db: DatabaseSync, id: ThreadId): void {
  requireDeleted(db, id);
  for (const { table } of transcriptPurgePlan(db))
    db.prepare(`DELETE FROM "${table}" WHERE thread_id=?`).run(id);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='intents'").get()) {
    db.prepare(
      "DELETE FROM intents WHERE thread_id=? AND status IN ('done','failed') AND awaiting=0 AND uncertain=0",
    ).run(id);
    db.prepare("DELETE FROM thread_state WHERE thread_id=?").run(id);
  }
  for (const table of engineRows)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      db.prepare(`DELETE FROM "${table}" WHERE thread_id=?`).run(id);
}
