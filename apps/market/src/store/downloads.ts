import { stampValue, takeStamp } from "./entries.ts";

/*
 * Download totals (ADR 0168 §3, §10; ADR 0173 §6). A download only counts: its version's total
 * (`downloads`), its entry's hour (`downloads_hourly`, kept 15 days, for trending) and its
 * version's day (`downloads_daily`, kept 400 days, for top publishers and signals). Nothing
 * names who fetched. The index shows totals as last folded (`counted`): the scheduled
 * aggregation folds every new count in one batch with one stamp, so `since` readers get new
 * totals without a stamp per download.
 */

export const hourlyKeptHours = 15 * 24;
export const dailyKeptDays = 400;
const pruneBatch = 1_000;

/** One more download for every signed version with these bytes, in one batch. */
export async function countDownload(db: D1Database, hash: string, now: number): Promise<void> {
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  await db.batch([
    db
      .prepare("UPDATE versions SET downloads = downloads + 1 WHERE hash = ?1 AND listed = 1")
      .bind(hash),
    db
      .prepare(
        `INSERT INTO downloads_hourly (type, name, hour, count)
          SELECT DISTINCT type, name, ?2, 1 FROM versions WHERE hash = ?1 AND listed = 1
          ON CONFLICT (type, name, hour) DO UPDATE SET count = count + 1`,
      )
      .bind(hash, hour),
    db
      .prepare(
        `INSERT INTO downloads_daily (type, name, version, day, count)
          SELECT type, name, version, ?2, 1 FROM versions WHERE hash = ?1 AND listed = 1
          ON CONFLICT (type, name, version, day) DO UPDATE SET count = count + 1`,
      )
      .bind(hash, day),
  ]);
}

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

/**
 * Deletes at most one batch of hourly rows older than 15 days and one of daily rows older than
 * 400; answers whether anything is left to prune.
 */
export async function pruneDownloads(db: D1Database, now: number): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000) - hourlyKeptHours;
  const day = Math.floor(now / 86_400_000) - dailyKeptDays;
  const [hourly, daily] = await db.batch([
    db
      .prepare(
        `DELETE FROM downloads_hourly WHERE rowid IN (
          SELECT rowid FROM downloads_hourly WHERE hour < ?1 LIMIT ${pruneBatch})`,
      )
      .bind(hour),
    db
      .prepare(
        `DELETE FROM downloads_daily WHERE rowid IN (
          SELECT rowid FROM downloads_daily WHERE day < ?1 LIMIT ${pruneBatch})`,
      )
      .bind(day),
  ]);
  return (hourly?.meta.changes ?? 0) === pruneBatch || (daily?.meta.changes ?? 0) === pruneBatch;
}
