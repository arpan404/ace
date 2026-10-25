import type { DatabaseSync } from "node:sqlite";

/**
 * Thread-owned tables whose rows are otherwise reached only by primary key. Storage sizing and
 * transcript purges select them by thread; without these indexes each per-thread read, and each
 * cascade from a deleted thread, reads the whole table. On a large history that held the event
 * loop for seconds per thread. Built when the store opens, before the daemon listens; a no-op
 * once they exist. The first build on a 9 GB history took 0.2 s warm and 1.6 s cold, and 1.3–1.8 s
 * at ten times its row counts. It stays here, once per database: CREATE INDEX holds the write
 * lock, so building it from another connection while the daemon serves would block every write.
 */
const indexes = [
  ["output_streams", "output_streams_thread"],
  ["item_text_streams", "item_text_streams_thread"],
  ["history_blobs", "history_blobs_thread"],
  ["ace_results", "ace_results_thread"],
] as const;

export function indexThreadRows(db: DatabaseSync): void {
  const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  for (const [table, index] of indexes)
    if (present.get(table)) db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(thread_id)`);
}
