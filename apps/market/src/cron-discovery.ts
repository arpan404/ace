import {
  rankScores,
  tierOf,
  topPublishers,
  trendRules,
  trendScores,
  type HourCount,
} from "@ace/marketplace";
import { fromCatalogues, type Databases } from "./store/databases.ts";
import { pruneDownloads } from "./store/downloads.ts";
import { officialPublisher } from "./store/lists.ts";

/*
 * Discover's cron steps (ADR 0173 §6, §16), each bounded: old download buckets pruned in
 * batches; trending scored 500 entries a step, walking each catalogue in turn with a cursor
 * (the catalogue and its row) in the counts database's `meta`, into `trending_scores`, then
 * swapped into `trending` when a pass has walked every catalogue, with top publishers ranked at
 * the same time. No step reads more than a batch of entries' last three weeks of hours.
 */

export const trendingBatch = 500;
const stepsPerRun = 8;
const prunesPerRun = 5;

async function meta(db: D1Database, key: string): Promise<number | undefined> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = ?1")
    .bind(key)
    .first<{ value: number }>();
  return row?.value;
}
const setMeta = (db: D1Database, key: string, value: number) =>
  db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);

export async function discoveryCron(dbs: Databases, now: number): Promise<void> {
  for (let step = 0; step < prunesPerRun; step++)
    if (!(await pruneDownloads(dbs.counts, now))) break;
  for (let step = 0; step < stepsPerRun; step++) if (await trendingStep(dbs, now)) break;
}

/** One batch of a trending pass; true once the pass completed and was swapped in. */
export async function trendingStep(dbs: Databases, now: number): Promise<boolean> {
  const db = dbs.counts;
  let cursor = await meta(db, "trending_cursor");
  let atHour = await meta(db, "trending_at");
  let walking = (await meta(db, "trending_catalogue")) ?? 0;
  if (cursor === undefined || cursor < 0 || atHour === undefined) {
    cursor = 0;
    walking = 0;
    atHour = Math.floor(now / 3_600_000);
    await db.batch([
      db.prepare("DELETE FROM trending_scores"),
      setMeta(db, "trending_cursor", 0),
      setMeta(db, "trending_catalogue", 0),
      setMeta(db, "trending_at", atHour),
    ]);
  }
  const catalogue = dbs.catalogues[walking];
  if (!catalogue) {
    await swapTrending(dbs, now);
    return true;
  }
  const official = await officialPublisher(dbs.publishers);
  const { results: batch } = await catalogue.db
    .prepare(
      `SELECT e.rowid AS position, e.type, e.name, e.publisher, p.verified FROM entries e
        JOIN publisher_copies p ON p.id = e.publisher
        WHERE e.rowid > ?1 AND e.listed = 1 AND e.visibility = 'listed' AND e.archived = 0
          AND p.state = 'active'
        ORDER BY e.rowid LIMIT ${trendingBatch}`,
    )
    .bind(cursor)
    .all<{ position: number; type: string; name: string; publisher: string; verified: number }>();
  if (batch.length > 0) {
    // The week now and the week before, each with its own week of baseline.
    const from = atHour - 3 * trendRules.windowHours;
    const { results: hours } = await db
      .prepare(
        `SELECT type, name, hour, count FROM downloads_hourly
          WHERE hour > ?1 AND (type || '/' || name) IN (SELECT value FROM json_each(?2))`,
      )
      .bind(from, JSON.stringify(batch.map((row) => `${row.type}/${row.name}`)))
      .all<{ type: string; name: string; hour: number; count: number }>();
    const byEntry = new Map<string, HourCount[]>();
    for (const row of hours) {
      const key = `${row.type}/${row.name}`;
      const list = byEntry.get(key) ?? [];
      list.push({ hour: row.hour, count: row.count });
      byEntry.set(key, list);
    }
    const scored = batch.flatMap((row) => {
      const counts = byEntry.get(`${row.type}/${row.name}`) ?? [];
      const tier = tierOf({ official: row.publisher === official, verified: row.verified === 1 });
      // Last week's qualifiers stay in, so last week's ranks are the real ones.
      const scores = trendScores(counts, tier, atHour);
      return scores ? [{ type: row.type, name: row.name, ...scores }] : [];
    });
    await db.batch([
      db
        .prepare(
          `INSERT INTO trending_scores (type, name, score, week, before)
            SELECT json_extract(value, '$.type'), json_extract(value, '$.name'),
              json_extract(value, '$.score'), json_extract(value, '$.week'),
              json_extract(value, '$.before') FROM json_each(?1) WHERE true
            ON CONFLICT (type, name) DO UPDATE SET score = excluded.score,
              week = excluded.week, before = excluded.before`,
        )
        .bind(JSON.stringify(scored)),
      setMeta(db, "trending_cursor", batch.at(-1)?.position ?? cursor),
    ]);
  }
  if (batch.length === trendingBatch) return false;
  // This catalogue is walked: the next step starts on the next one.
  await db.batch([
    setMeta(db, "trending_cursor", 0),
    setMeta(db, "trending_catalogue", walking + 1),
  ]);
  if (walking + 1 < dbs.catalogues.length) return false;
  await swapTrending(dbs, now);
  return true;
}

async function swapTrending(dbs: Databases, now: number) {
  const db = dbs.counts;
  const { results } = await db
    .prepare("SELECT type, name, score, week, before FROM trending_scores")
    .all<{ type: string; name: string; score: number; week: number; before: number }>();
  const rows = rankScores(
    results.map((row) => Object.assign({ key: `${row.type}/${row.name}` }, row)),
  ).map((row) => {
    const [type, name] = row.key.split("/");
    return {
      rank: row.rank,
      type,
      name,
      score: row.score,
      week: row.week,
      movement: row.movement,
    };
  });
  await db.batch([
    db.prepare("DELETE FROM trending"),
    db
      .prepare(
        `INSERT INTO trending (rank, type, name, score, week, movement)
          SELECT json_extract(value, '$.rank'), json_extract(value, '$.type'),
            json_extract(value, '$.name'), json_extract(value, '$.score'),
            json_extract(value, '$.week'), json_extract(value, '$.movement')
          FROM json_each(?1)`,
      )
      .bind(
        JSON.stringify(
          rows.map((row) => Object.assign({}, row, { movement: JSON.stringify(row.movement) })),
        ),
      ),
    db.prepare("DELETE FROM trending_scores"),
    setMeta(db, "trending_cursor", -1),
    setMeta(db, "trending_catalogue", 0),
    setMeta(db, "trending_ranked", now),
  ]);
  await rankTopPublishers(dbs, now);
}

/**
 * Active publishers with a listed, reviewed entry, by capped 30-day downloads × tier. A day's
 * downloads of shared bytes were credited to one entry when they were counted, so copies add
 * nothing (`store/downloads.ts`).
 */
export async function rankTopPublishers(dbs: Databases, now: number) {
  const today = Math.floor(now / 86_400_000);
  const [official, listed, days, publisherRows] = await Promise.all([
    officialPublisher(dbs.publishers),
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare(
          `SELECT p.id, e.type, e.name AS entry, e.reviewed FROM entries e
            JOIN publisher_copies p ON p.id = e.publisher
            WHERE e.listed = 1 AND p.state = 'active'`,
        )
        .all<{ id: string; type: string; entry: string; reviewed: number }>();
      return results;
    }),
    dbs.counts
      .prepare("SELECT type, name, day, count FROM credited_daily WHERE day > ?1")
      .bind(today - 30)
      .all<{ type: string; name: string; day: number; count: number }>(),
    dbs.publishers
      .prepare("SELECT id, name, verified FROM publishers WHERE state = 'active'")
      .all<{ id: string; name: string; verified: number }>(),
  ]);
  const reviewed = new Set(listed.filter((row) => row.reviewed === 1).map((row) => row.id));
  const profile = new Map(publisherRows.results.map((row) => [row.id, row]));
  const publishers = {
    results: listed.flatMap((row) => {
      const found = profile.get(row.id);
      return found && reviewed.has(row.id)
        ? [
            {
              id: row.id,
              name: found.name,
              verified: found.verified,
              type: row.type,
              entry: row.entry,
            },
          ]
        : [];
    }),
  };
  const perEntry = new Map<string, { day: number; count: number }[]>();
  for (const row of days.results) {
    const key = `${row.type}/${row.name}`;
    perEntry.set(key, [...(perEntry.get(key) ?? []), { day: row.day, count: row.count }]);
  }
  const byPublisher = new Map<
    string,
    { id: string; handle: string; verified: boolean; entries: { day: number; count: number }[][] }
  >();
  for (const row of publishers.results) {
    const publisher = byPublisher.get(row.id) ?? {
      id: row.id,
      handle: row.name,
      verified: row.verified === 1,
      entries: [],
    };
    publisher.entries.push(perEntry.get(`${row.type}/${row.entry}`) ?? []);
    byPublisher.set(row.id, publisher);
  }
  const ranked = topPublishers(
    [...byPublisher.values()].map((publisher) =>
      Object.assign({}, publisher, {
        tier: tierOf({ official: publisher.id === official, verified: publisher.verified }),
      }),
    ),
    today,
  );
  const db = dbs.counts;
  await db.batch([
    db.prepare("DELETE FROM top_publishers"),
    db
      .prepare(
        `INSERT INTO top_publishers (rank, publisher, downloads, entries)
          SELECT json_extract(value, '$.rank'), json_extract(value, '$.id'),
            json_extract(value, '$.downloads'), json_extract(value, '$.entries')
          FROM json_each(?1)`,
      )
      .bind(JSON.stringify(ranked)),
  ]);
}
