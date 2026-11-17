import { eachCatalogue, type Databases } from "./databases.ts";
import { stampValue, takeStamp } from "./entries.ts";
import type { ListedCopy } from "./read.ts";

/*
 * Download totals (ADR 0168 §3, §10; ADR 0173 §6, §16), in the counts database. A download only
 * counts: every listed version with the fetched bytes gets one more in its total
 * (`version_totals`) and its day (`downloads_daily`, kept 400 days, for publishers' signals),
 * and the entry ranking credits for the bytes (`creditedCopy`: the first listed with them, so
 * copies and re-published versions add nothing) one more in its hour (`downloads_hourly`, kept
 * 15 days, for trending) and its day (`credited_daily`, kept 45 days, for top publishers), all
 * in one counts batch. Nothing names who fetched.
 *
 * The index shows totals as last folded into each catalogue (`versions.counted`): the cron
 * writes the totals there as absolute values with one stamp, restamping only entries whose
 * total moved, then marks them folded. A fold cut off part way is redone with the same values.
 */

export const hourlyKeptHours = 15 * 24;
export const creditedKeptDays = 45;
export const dailyKeptDays = 400;
const pruneBatch = 1_000;
const foldBatch = 2_000;

/**
 * The listed copy ranking credits a fetch of shared bytes to: the first listed (earliest
 * `published`), then by type, name and version, so every catalogue's answer agrees.
 */
export function creditedCopy(copies: readonly ListedCopy[]): ListedCopy | undefined {
  return copies.toSorted(
    (a, b) =>
      a.published - b.published ||
      a.type.localeCompare(b.type) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  )[0];
}

/** An insert of one row per version in the JSON list `?1`. */
const each = (sql: string) => `${sql} SELECT json_extract(value, '$.type'),
    json_extract(value, '$.name'), json_extract(value, '$.version')`;

/** One more download of the bytes the listed `copies` share, in one counts batch. */
export async function countDownload(
  counts: D1Database,
  copies: readonly ListedCopy[],
  now: number,
): Promise<void> {
  const credited = creditedCopy(copies);
  if (!credited) return;
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const list = JSON.stringify(copies.map(({ type, name, version }) => ({ type, name, version })));
  await counts.batch([
    counts
      .prepare(
        `${each("INSERT INTO version_totals (type, name, version, downloads)")}, 1
          FROM json_each(?1) WHERE true
          ON CONFLICT (type, name, version) DO UPDATE SET downloads = downloads + 1`,
      )
      .bind(list),
    counts
      .prepare(
        `${each("INSERT INTO downloads_daily (type, name, version, day, count)")}, ?2, 1
          FROM json_each(?1) WHERE true
          ON CONFLICT (type, name, version, day) DO UPDATE SET count = count + 1`,
      )
      .bind(list, day),
    counts
      .prepare(
        `INSERT INTO downloads_hourly (type, name, hour, count) VALUES (?1, ?2, ?3, 1)
          ON CONFLICT (type, name, hour) DO UPDATE SET count = count + 1`,
      )
      .bind(credited.type, credited.name, hour),
    counts
      .prepare(
        `INSERT INTO credited_daily (type, name, day, count) VALUES (?1, ?2, ?3, 1)
          ON CONFLICT (type, name, day) DO UPDATE SET count = count + 1`,
      )
      .bind(credited.type, credited.name, day),
  ]);
}

/**
 * Each version's download total now, by `type/name@version`, for these entries: entry pages and
 * a publisher's own pages show these, while the index shows totals as last folded.
 */
export async function liveTotals(
  counts: D1Database,
  entries: readonly { type: string; name: string }[],
): Promise<Map<string, number>> {
  if (entries.length === 0) return new Map();
  const { results } = await counts
    .prepare(
      `SELECT type, name, version, downloads FROM version_totals
        WHERE (type || '/' || name) IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(entries.map((entry) => `${entry.type}/${entry.name}`)))
    .all<{ type: string; name: string; version: string; downloads: number }>();
  return new Map(results.map((row) => [`${row.type}/${row.name}@${row.version}`, row.downloads]));
}

interface Unfolded {
  type: string;
  name: string;
  version: string;
  downloads: number;
}

/**
 * Folds new totals into each catalogue: in one catalogue batch, a stamp, the entries whose
 * totals move restamped, and the versions' totals written as absolute values; then the counts
 * database marks what was written folded. An entry whose totals didn't move keeps its stamp.
 */
export async function aggregateDownloads(dbs: Databases, now: number): Promise<void> {
  await eachCatalogue(dbs, async ({ type, db }) => {
    const { results } = await dbs.counts
      .prepare(
        `SELECT type, name, version, downloads FROM version_totals
          WHERE type = ?1 AND downloads != folded LIMIT ${foldBatch}`,
      )
      .bind(type)
      .all<Unfolded>();
    if (results.length === 0) return;
    const totals = JSON.stringify(results);
    const moved = `SELECT 1 FROM versions v, json_each(?1) t
      WHERE v.type = json_extract(t.value, '$.type') AND v.name = json_extract(t.value, '$.name')
        AND v.version = json_extract(t.value, '$.version')
        AND v.counted != json_extract(t.value, '$.downloads')`;
    await db.batch([
      takeStamp(db, now),
      db
        .prepare(
          `UPDATE entries SET updated = ${stampValue} WHERE listed = 1 AND EXISTS (
            ${moved} AND v.type = entries.type AND v.name = entries.name)`,
        )
        .bind(totals),
      db
        .prepare(
          `UPDATE versions SET counted = (SELECT json_extract(t.value, '$.downloads')
              FROM json_each(?1) t WHERE json_extract(t.value, '$.name') = versions.name
              AND json_extract(t.value, '$.version') = versions.version)
            WHERE type = ?2 AND (name || '@' || version) IN (SELECT json_extract(value, '$.name')
              || '@' || json_extract(value, '$.version') FROM json_each(?1))`,
        )
        .bind(totals, type),
    ]);
    await dbs.counts
      .prepare(
        `UPDATE version_totals SET folded = (SELECT json_extract(t.value, '$.downloads')
            FROM json_each(?1) t WHERE json_extract(t.value, '$.name') = version_totals.name
            AND json_extract(t.value, '$.version') = version_totals.version)
          WHERE type = ?2 AND (name || '@' || version) IN (SELECT json_extract(value, '$.name')
            || '@' || json_extract(value, '$.version') FROM json_each(?1))`,
      )
      .bind(totals, type)
      .run();
  });
}

/**
 * Deletes at most one batch each of hourly rows older than 15 days, credited days older than 45
 * and version days older than 400; answers whether anything is left to prune.
 */
export async function pruneDownloads(counts: D1Database, now: number): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000) - hourlyKeptHours;
  const today = Math.floor(now / 86_400_000);
  const prune = (table: string, column: string, before: number) =>
    counts
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (
          SELECT rowid FROM ${table} WHERE ${column} < ?1 LIMIT ${pruneBatch})`,
      )
      .bind(before);
  const results = await counts.batch([
    prune("downloads_hourly", "hour", hour),
    prune("credited_daily", "day", today - creditedKeptDays),
    prune("downloads_daily", "day", today - dailyKeptDays),
  ]);
  return results.some((result) => (result.meta.changes ?? 0) === pruneBatch);
}
