import {
  rankScores,
  tierOf,
  topPublishers,
  trendRules,
  trendScore,
  type HourCount,
} from "@ace/marketplace";
import type { Env } from "./env.ts";
import { pruneDownloads } from "./store/downloads.ts";
import { officialPublisher } from "./store/lists.ts";

/*
 * Discover's cron steps (ADR 0173 §6), each bounded: old download buckets pruned in batches;
 * trending scored 500 entries a step with a cursor in `meta` into `trending_scores`, then swapped
 * into `trending` when a pass completes, with top publishers ranked at the same time. No step
 * reads more than a batch of entries' last three weeks of hours.
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

export async function discoveryCron(env: Env, now: number): Promise<void> {
  const db = env.MARKET;
  for (let step = 0; step < prunesPerRun; step++) if (!(await pruneDownloads(db, now))) break;
  for (let step = 0; step < stepsPerRun; step++) if (await trendingStep(db, now)) break;
}

/** One batch of a trending pass; true once the pass completed and was swapped in. */
export async function trendingStep(db: D1Database, now: number): Promise<boolean> {
  let cursor = await meta(db, "trending_cursor");
  let atHour = await meta(db, "trending_at");
  if (cursor === undefined || cursor < 0 || atHour === undefined) {
    cursor = 0;
    atHour = Math.floor(now / 3_600_000);
    await db.batch([
      db.prepare("DELETE FROM trending_scores"),
      setMeta(db, "trending_cursor", 0),
      setMeta(db, "trending_at", atHour),
    ]);
  }
  const official = await officialPublisher(db);
  const { results: batch } = await db
    .prepare(
      `SELECT e.rowid AS position, e.type, e.name, e.publisher, p.verified FROM entries e
        JOIN publishers p ON p.id = e.publisher
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
      const score = trendScore(counts, tier, atHour);
      if (!score) return [];
      const before = trendScore(counts, tier, atHour - trendRules.windowHours);
      return [{ type: row.type, name: row.name, ...score, before: before?.score ?? 0 }];
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
  await swapTrending(db, now);
  return true;
}

async function swapTrending(db: D1Database, now: number) {
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
    setMeta(db, "trending_ranked", now),
  ]);
  await rankTopPublishers(db, now);
}

/** Active publishers with a listed, reviewed entry, by capped 30-day downloads × tier. */
export async function rankTopPublishers(db: D1Database, now: number) {
  const today = Math.floor(now / 86_400_000);
  const official = await officialPublisher(db);
  const [publishers, days] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.name, p.verified, e.type, e.name AS entry FROM publishers p
          JOIN entries e ON e.publisher = p.id AND e.listed = 1
          WHERE p.state = 'active' AND EXISTS (SELECT 1 FROM entries r
            WHERE r.publisher = p.id AND r.listed = 1 AND r.reviewed = 1)`,
      )
      .all<{ id: string; name: string; verified: number; type: string; entry: string }>(),
    db
      .prepare(
        `SELECT d.type, d.name, d.day, SUM(d.count) AS count FROM downloads_daily d
          JOIN entries e ON e.type = d.type AND e.name = d.name AND e.listed = 1
          WHERE d.day > ?1 GROUP BY d.type, d.name, d.day`,
      )
      .bind(today - 30)
      .all<{ type: string; name: string; day: number; count: number }>(),
  ]);
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
