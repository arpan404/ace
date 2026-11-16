import type { DatabaseSync } from "node:sqlite";

/**
 * Which history revisions and streamed text chunks were written at each sequence, so the idle
 * trust pass (`stored-trust-batch.ts`, ADR 0125) finds every one of them by the sequence alone.
 *
 * Neither table is keyed by sequence, and an index on it would have to be built in one statement
 * over the whole table: on a large home that held the daemon's open for over a minute. So the
 * map is `stored_trust_rows`, kept by triggers on both tables for every row written or removed
 * from the moment they exist, and filled for the rows that were already there in bounded batches,
 * in rowid order, from the pass's idle ticks (`indexStoredTrustRows`). Until that backfill is
 * complete (`storedTrustRowsComplete`) the pass confirms nothing, so older rows stay validated on
 * read. Open only creates what is missing; a table without its triggers (a new home, a home from
 * before the map, or a later step that rebuilt the table) starts its backfill over, unless it is
 * empty.
 */

const sources = [
  { kind: 0, table: "history_item_revisions" },
  { kind: 1, table: "item_text_chunks" },
] as const;
/** The kind of a mapped row: a history revision or a streamed text chunk. */
export const revisionRow = sources[0].kind;
export const chunkRow = sources[1].kind;

/** Rows of an older table one backfill batch maps at most. */
export const rowsPerBackfill = 2048;

/**
 * Create the map and its triggers where missing, in one transaction. The plain sequence indexes
 * an earlier build created at open are dropped: the map replaces them, and dropping is cheap.
 */
export function openStoredTrustRows(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP INDEX IF EXISTS history_item_revisions_seq;
      DROP INDEX IF EXISTS item_text_chunks_seq;
      CREATE TABLE IF NOT EXISTS stored_trust_rows (
        seq INTEGER NOT NULL, kind INTEGER NOT NULL, item_id TEXT NOT NULL,
        PRIMARY KEY(seq, kind, item_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS stored_trust_rows_backfill (
        kind INTEGER PRIMARY KEY, item_id TEXT, seq INTEGER
      );`);
    for (const { kind, table } of sources) {
      const insert = `stored_trust_rows_${table}_insert`;
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(insert);
      if (exists) continue;
      db.exec(`CREATE TRIGGER ${insert} AFTER INSERT ON ${table} BEGIN
          INSERT OR IGNORE INTO stored_trust_rows VALUES (new.seq, ${kind}, new.item_id);
        END;
        CREATE TRIGGER IF NOT EXISTS stored_trust_rows_${table}_delete AFTER DELETE ON ${table} BEGIN
          DELETE FROM stored_trust_rows WHERE seq = old.seq AND kind = ${kind} AND item_id = old.item_id;
        END;`);
      // Rows written before the triggers are mapped by the backfill; an empty table has none.
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        db.prepare("INSERT OR REPLACE INTO stored_trust_rows_backfill VALUES (?, NULL, NULL)").run(
          kind,
        );
      else db.prepare("DELETE FROM stored_trust_rows_backfill WHERE kind = ?").run(kind);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Whether every revision and chunk row is in the map, so the pass may confirm sequences. */
export function storedTrustRowsComplete(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM stored_trust_rows_backfill LIMIT 1").get() === undefined;
}

/**
 * Map the next `limit` rows of the first table still being backfilled, in primary key order
 * (`item_id`, `seq`): both tables' key index holds the two columns, so a batch reads that index
 * alone and none of the rows' bodies. A key never changes, so every row there when the triggers
 * were created is passed once; one removed before its batch has nothing to map, and one written
 * since is mapped already and ignored. Returns false when nothing was left to map. Writes only the
 * map's own tables.
 */
export function indexStoredTrustRows(db: DatabaseSync, limit = rowsPerBackfill): boolean {
  for (const { kind, table } of sources) {
    const cursor = db
      .prepare("SELECT item_id, seq FROM stored_trust_rows_backfill WHERE kind = ?")
      .get(kind);
    if (!cursor) continue;
    const page = `SELECT item_id, seq FROM ${table}`;
    const order = "ORDER BY item_id, seq LIMIT ?";
    const rows =
      typeof cursor.item_id === "string"
        ? db
            .prepare(`${page} WHERE (item_id, seq) > (?, ?) ${order}`)
            .all(cursor.item_id, Number(cursor.seq), limit)
        : db.prepare(`${page} ${order}`).all(limit);
    const insert = db.prepare("INSERT OR IGNORE INTO stored_trust_rows VALUES (?, ?, ?)");
    for (const row of rows) insert.run(Number(row.seq), kind, String(row.item_id));
    const last = rows.at(-1);
    if (rows.length < limit || !last)
      db.prepare("DELETE FROM stored_trust_rows_backfill WHERE kind = ?").run(kind);
    else
      db.prepare("UPDATE stored_trust_rows_backfill SET item_id = ?, seq = ? WHERE kind = ?").run(
        String(last.item_id),
        Number(last.seq),
        kind,
      );
    return true;
  }
  return false;
}
