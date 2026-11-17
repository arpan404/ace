import { fromCatalogues, type Databases } from "./databases.ts";
import { chargeItem } from "./me-limits.ts";

/*
 * The quota ledger's reconcile (ADR 0173 §16). A version's bytes are charged to its publisher in
 * the publishers database before the version is stored in its catalogue, and only this corrects
 * the ledger: per publisher, it reads every catalogue for the versions it owns that aren't
 * blocked, then in one publishers batch writes each one's charge and drops charges for anything
 * else. A charge younger than `chargeGraceMs` is never dropped or lowered, so a version on its
 * way to its catalogue is never undercounted; one that never got stored is dropped a run later.
 * A request that changes what a publisher stores marks it (`usage_dirty`); the cron reconciles
 * marked publishers first, then the longest unchecked.
 */

export const chargeGraceMs = 10 * 60_000;

export async function reconcileUsage(
  dbs: Databases,
  publisher: string,
  now: number,
): Promise<void> {
  const versions = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT v.type, v.name, v.version, v.size FROM versions v
          JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE e.publisher = ?1 AND v.state != 'blocked'`,
      )
      .bind(publisher)
      .all<{ type: string; name: string; version: string; size: number }>();
    return results;
  });
  const expected = JSON.stringify(
    versions.map((version) => ({ item: chargeItem(version), size: version.size })),
  );
  const settled = now - chargeGraceMs;
  const db = dbs.publishers;
  await db.batch([
    db
      .prepare(
        `DELETE FROM charges WHERE publisher = ?1 AND at < ?2 AND item NOT IN (
          SELECT json_extract(value, '$.item') FROM json_each(?3))`,
      )
      .bind(publisher, settled, expected),
    db
      .prepare(
        `INSERT INTO charges (item, publisher, size, at)
          SELECT json_extract(value, '$.item'), ?1, json_extract(value, '$.size'), 0
            FROM json_each(?3) WHERE true
          ON CONFLICT (item) DO UPDATE SET publisher = excluded.publisher, size = excluded.size
            WHERE charges.at < ?2`,
      )
      .bind(publisher, settled, expected),
    // A mark set while this read the catalogues stays, for the next run.
    db
      .prepare(
        `UPDATE publishers SET usage_checked = ?2,
            usage_dirty = CASE WHEN usage_dirty <= ?2 THEN NULL ELSE usage_dirty END
          WHERE id = ?1`,
      )
      .bind(publisher, now),
  ]);
}

/** The cron's step: marked publishers whose mark has settled, then the longest unchecked. */
export async function reconcileDue(
  dbs: Databases,
  now: number,
  limits: { marked: number; sweep: number },
): Promise<void> {
  const [marked, sweep] = await Promise.all([
    dbs.publishers
      .prepare(
        `SELECT id FROM publishers WHERE usage_dirty IS NOT NULL AND usage_dirty < ?1
          ORDER BY usage_dirty LIMIT ?2`,
      )
      .bind(now - chargeGraceMs, limits.marked)
      .all<{ id: string }>(),
    dbs.publishers
      .prepare("SELECT id FROM publishers ORDER BY usage_checked LIMIT ?1")
      .bind(limits.sweep)
      .all<{ id: string }>(),
  ]);
  const ids = new Set([...marked.results, ...sweep.results].map((row) => row.id));
  for (const id of ids) await reconcileUsage(dbs, id, now);
}
