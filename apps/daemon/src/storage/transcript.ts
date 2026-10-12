import type { DatabaseSync } from "node:sqlite";
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
]);
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

export function transcriptBytes(db: DatabaseSync, id: ThreadId): number {
  let bytes = Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(octet_length(payload)),0) AS bytes FROM events WHERE thread_id=?",
      )
      .get(id)?.bytes,
  );
  for (const table of tables(db)) {
    const columns = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .flatMap((column) =>
        typeof column.name === "string" && /^[a-z_]+$/.test(column.name) ? [column.name] : [],
      );
    if (!columns.length) continue;
    const expression = columns.map((name) => `COALESCE(octet_length("${name}"),0)`).join("+");
    bytes += Number(
      db
        .prepare(`SELECT COALESCE(SUM(${expression}),0) AS bytes FROM "${table}" WHERE thread_id=?`)
        .get(id)?.bytes,
    );
  }
  // Chunk ownership is indirect. Their byte metadata does not materialize large payloads.
  for (const [chunks, streams, key] of [
    ["output_chunks", "output_streams", "stream_id"],
    ["item_source_chunks", "item_text_streams", "stream_id"],
    ["history_blob_chunks", "history_blobs", "blob_id"],
    ["streamed_blob_chunks", "streamed_blobs", "blob_id"],
  ])
    bytes += Number(
      db
        .prepare(
          `SELECT COALESCE(SUM(octet_length(c.bytes)),0) AS bytes FROM ${chunks} c JOIN ${streams} s ON c.${key}=s.id WHERE s.thread_id=?`,
        )
        .get(id)?.bytes,
    );
  return bytes;
}

/** Caller has committed a tombstone and stopped the idle engine owner before entering SQLite. */
export function purgeTranscript(db: DatabaseSync, id: ThreadId): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM threads WHERE id=? AND json_extract(client,'$.deletedAt') IS NOT NULL",
      )
      .get(id)
  )
    throw new Error("thread_not_deleted");
  // Delete referencing rows before their parent records, using the existing FK cascades for chunks.
  const selected = tables(db);
  for (const table of selected.filter(
    (name) => name !== "items" && name !== "ace_results" && name !== "ace_tools",
  ))
    db.prepare(`DELETE FROM "${table}" WHERE thread_id=?`).run(id);
  for (const table of ["items", "ace_results", "ace_tools"])
    if (selected.includes(table)) db.prepare(`DELETE FROM "${table}" WHERE thread_id=?`).run(id);
  db.prepare("DELETE FROM events WHERE thread_id=?").run(id);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='intents'").get()) {
    db.prepare(
      "DELETE FROM intents WHERE thread_id=? AND status IN ('done','failed') AND awaiting=0 AND uncertain=0",
    ).run(id);
    db.prepare("DELETE FROM thread_state WHERE thread_id=?").run(id);
  }
}
