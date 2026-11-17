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
 * The engine's state for the thread and its own rows: session, selection and queue. Without its state
 * they only lead a reader to a thread it can no longer load (ADR 0177), so a purge removes them.
 */
const engineRows = [
  "thread_state",
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

/**
 * Tables a purge empties beyond the transcript payload counted above: indexes and read models
 * of the thread's own history, which grow with it.
 */
const historyTables = new Set([
  "item_text_streams",
  "history_items",
  "history_stream_versions",
  "history_inventory",
  "view_entity_windows",
]);
function purgedTables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .flatMap((row) => {
      const name = String(row.name);
      const listed =
        payloadTables.has(name) || historyTables.has(name) || /^(long|client)_[a-z_]+$/.test(name);
      return listed && columnsOf(db, name).includes("thread_id") ? [name] : [];
    });
}
function columnsOf(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((column) => String(column.name));
}

/**
 * One set of rows a purge removes: `rows` is the FROM clause (aliased `r`, the thread id bound as
 * `?1`) that selects them, `key` how a delete names them in `table`, `pick` that key read from `r`.
 */
export interface PurgeStep {
  table: string;
  key: string;
  pick: string;
  rows: string;
}

/**
 * Which of `table`'s rows (aliased `alias`) are the thread's, through an index: two tables have
 * none that leads with thread_id, so they are reached through ones that do while those remain.
 */
function threadRows(table: string, alias: string): string {
  if (table === "item_text_streams")
    return `${alias}.item_id IN (SELECT id FROM items WHERE thread_id=?1)`;
  if (table === "history_stream_versions")
    return `${alias}.stream_id IN (SELECT id FROM output_streams WHERE thread_id=?1
      UNION ALL SELECT s.id FROM item_text_streams s JOIN items i ON i.id=s.item_id WHERE i.thread_id=?1)`;
  return `${alias}.thread_id=?1`;
}

/**
 * Everything a purge removes, in order, read once per purge (ADR 0177):
 * 1. Rows owned by one of the thread's rows through a cascading key and carrying no thread id of
 *    their own (stream and blob chunks, item text, revisions), so deleting an owner later
 *    cascades into nothing.
 * 2. The thread's own rows: those reached through other rows before those go, referencing rows
 *    before the records they name, then any left that only a scan finds.
 * 3. Its finished intents, then its events.
 */
export function transcriptPurgePlan(db: DatabaseSync): PurgeStep[] {
  const owners = purgedTables(db);
  const reached = ["history_stream_versions", "item_text_streams"].filter((name) =>
    owners.includes(name),
  );
  const records = ["items", "ace_results", "ace_tools", "history_items"];
  const owned: PurgeStep[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const table = String(name);
    if (columnsOf(db, table).includes("thread_id")) continue;
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      const owner = String(fk.table);
      if (!owners.includes(owner) || fk.on_delete !== "CASCADE") continue;
      owned.push(
        step(
          db,
          table,
          `"${table}" AS r JOIN "${owner}" AS o ON o."${String(fk.to)}"=r."${String(fk.from)}" WHERE ${threadRows(owner, "o")}`,
        ),
      );
    }
  }
  const own = (table: string) => step(db, table, `"${table}" AS r WHERE ${threadRows(table, "r")}`);
  const scanned = (table: string) => step(db, table, `"${table}" AS r WHERE r.thread_id=?1`);
  const intents = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intents'")
    .get()
    ? [
        step(
          db,
          "intents",
          `"intents" AS r WHERE r.thread_id=?1 AND r.status IN ('done','failed') AND r.awaiting=0 AND r.uncertain=0`,
        ),
      ]
    : [];
  return [
    ...owned,
    ...reached.map(own),
    ...owners.filter((name) => !records.includes(name) && !reached.includes(name)).map(own),
    ...records.filter((name) => owners.includes(name)).map(own),
    ...reached.map(scanned),
    ...intents,
    own("events"),
  ];
}
/** A step over `table`'s rows that `rows` selects, keyed by rowid or, without one, its primary key. */
function step(db: DatabaseSync, table: string, rows: string): PurgeStep {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!String(sql?.sql ?? "").includes("WITHOUT ROWID"))
    return { table, key: "rowid", pick: "r.rowid", rows };
  const columns = db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .filter((column) => Number(column.pk) > 0)
    .toSorted((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => `"${String(column.name)}"`);
  return {
    table,
    key: `(${columns.join(",")})`,
    pick: columns.map((column) => `r.${column}`).join(","),
    rows,
  };
}

/** Rows changed on this connection so far, cascades and triggers included. */
function changes(db: DatabaseSync): number {
  return Number(db.prepare("SELECT total_changes() AS n").get()?.n);
}

/** Where a purge stands: the step it reached, and every row its last write changed. */
export interface PurgeProgress {
  step: number;
  changed: number;
}

/**
 * Deletes at most `limit` rows of a deleted thread, from the first step in `plan` at or after
 * `from` that still has any. `changed` is every row the write changed, cascades included; 0 once
 * nothing is left. Owned rows go first, so an owner's delete never cascades past its batch, and
 * steps already emptied are not read again. Each call is one short write, so a large thread is
 * purged a batch at a time (ADR 0170, 0177).
 */
export function purgeTranscriptBatch(
  db: DatabaseSync,
  id: ThreadId,
  plan: readonly PurgeStep[],
  limit: number,
  from = 0,
): PurgeProgress {
  requireDeleted(db, id);
  for (let at = from; at < plan.length; at++) {
    const current = plan[at];
    if (!current) break;
    const before = changes(db);
    db.prepare(
      `DELETE FROM "${current.table}" WHERE ${current.key} IN (SELECT ${current.pick} FROM ${current.rows} LIMIT ?2)`,
    ).run(id, limit);
    const changed = changes(db) - before;
    if (changed > 0) return { step: at, changed };
  }
  return { step: plan.length, changed: 0 };
}

/**
 * The purge's last, small step: whatever is left of the transcript (nothing, after the batches),
 * the thread's finished intents, its engine state and the engine's own rows. Caller has
 * committed a tombstone and stopped the idle engine owner before entering SQLite.
 */
export function purgeTranscript(db: DatabaseSync, id: ThreadId): void {
  requireDeleted(db, id);
  for (const { table, key, pick, rows } of transcriptPurgePlan(db))
    db.prepare(`DELETE FROM "${table}" WHERE ${key} IN (SELECT ${pick} FROM ${rows})`).run(id);
  for (const table of engineRows)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      db.prepare(`DELETE FROM "${table}" WHERE thread_id=?`).run(id);
}
