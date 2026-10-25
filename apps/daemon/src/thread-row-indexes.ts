import type { DatabaseSync } from "node:sqlite";

/**
 * Thread-owned tables whose rows are otherwise reached only by primary key. Storage sizing and
 * transcript purges select them by thread; without these indexes each per-thread read, and each
 * cascade from a deleted thread, reads the whole table. On a large history that held the event
 * loop for seconds per thread. Built when the store opens; a no-op once they exist.
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
