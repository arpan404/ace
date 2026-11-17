import type { Databases } from "./databases.ts";

/*
 * The daily size record (ADR 0173 §16): once a day, each database's size in bytes (D1's
 * `size_after`) and every table's row count, into the counts database, so growth toward D1's
 * 10 GB can be watched and a database split before it nears 5 GB.
 */

const day = 86_400_000;

/** Every database by the name the record keeps it under. */
export const recordedDatabases = (dbs: Databases): { name: string; db: D1Database }[] => [
  ...dbs.catalogues.map((catalogue) => ({ name: catalogue.type, db: catalogue.db })),
  { name: "publishers", db: dbs.publishers },
  { name: "counts", db: dbs.counts },
  { name: "moderation", db: dbs.moderation },
  { name: "lists", db: dbs.lists },
];

/** Records today's sizes unless today is recorded already. */
export async function recordSizes(dbs: Databases, now: number): Promise<void> {
  const today = Math.floor(now / day);
  const done = await dbs.counts
    .prepare("SELECT 1 AS found FROM database_sizes WHERE day = ?1 LIMIT 1")
    .bind(today)
    .first();
  if (done) return;
  for (const { name, db } of recordedDatabases(dbs)) {
    const tables = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name`,
      )
      .all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    const counted =
      names.length === 0
        ? []
        : await db.batch<{ rows: number }>(
            // Table names come from the schema itself, never from a request.
            names.map((table) => db.prepare(`SELECT COUNT(*) AS rows FROM "${table}"`)),
          );
    const bytes = tables.meta.size_after ?? 0;
    const rows = names.map((table, index) => ({
      name: table,
      rows: counted[index]?.results[0]?.rows ?? 0,
    }));
    await dbs.counts.batch([
      dbs.counts
        .prepare(
          `INSERT INTO database_sizes (day, database, bytes) VALUES (?1, ?2, ?3)
            ON CONFLICT (day, database) DO UPDATE SET bytes = excluded.bytes`,
        )
        .bind(today, name, bytes),
      dbs.counts
        .prepare(
          `INSERT INTO table_rows (day, database, name, rows)
            SELECT ?1, ?2, json_extract(value, '$.name'), json_extract(value, '$.rows')
              FROM json_each(?3) WHERE true
            ON CONFLICT (day, database, name) DO UPDATE SET rows = excluded.rows`,
        )
        .bind(today, name, JSON.stringify(rows)),
    ]);
  }
}
