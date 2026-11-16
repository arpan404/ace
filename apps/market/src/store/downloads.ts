import { stampValue, takeStamp } from "./entries.ts";

/*
 * Download totals in the index (ADR 0168 §3, §10). A download only counts (`downloads`); the
 * index shows totals as last folded (`counted`). The scheduled aggregation folds every new count
 * in one batch with one stamp, so `since` readers get new totals without a stamp per download.
 */

/** Folds new downloads into the index; an entry whose totals didn't move keeps its stamp. */
export async function aggregateDownloads(db: D1Database, now: number): Promise<void> {
  const moved = await db
    .prepare("SELECT 1 AS found FROM versions WHERE downloads != counted LIMIT 1")
    .first<{ found: number }>();
  if (!moved) return;
  await db.batch([
    takeStamp(db, now),
    db.prepare(
      `UPDATE entries SET updated = ${stampValue} WHERE listed = 1 AND EXISTS (
        SELECT 1 FROM versions v WHERE v.type = entries.type AND v.name = entries.name
          AND v.downloads != v.counted)`,
    ),
    db.prepare("UPDATE versions SET counted = downloads WHERE downloads != counted"),
  ]);
}
