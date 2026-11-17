import type { Databases } from "./databases.ts";

/*
 * The quota ledger's reconcile (ADR 0174 §16). A version's bytes are charged to its publisher in
 * the publishers database before the version is stored in its catalogue, and only this corrects
 * the ledger. Per publisher it runs as a pass (`usage_passes`), a bounded page at a time: it
 * walks every catalogue's versions the publisher owns that aren't blocked, by item, writing each
 * one's charge and marking it seen by this pass, with its cursor saved after every page. Only
 * when the pass has read every catalogue does it drop the publisher's charges it never saw, so a
 * pass cut off or out of budget drops nothing. A charge younger than `chargeGraceMs` before the
 * pass started is never dropped or lowered, so a version on its way to its catalogue is never
 * undercounted. A request that changes what a publisher stores marks it (`usage_dirty`); the cron
 * carries on passes in progress first, then marked publishers, then the longest unchecked.
 */

export const chargeGraceMs = 10 * 60_000;
const pageSize = 200;

export interface UsageBudget {
  versions: number;
}

interface Pass {
  started: number;
  catalogue: number;
  after: string;
}

/** One page of a publisher's versions in a catalogue, after `after` by item. */
async function versionPage(db: D1Database, publisher: string, after: string, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT v.type || '/' || v.name || '/' || v.version AS item, v.size FROM versions v
        JOIN entries e ON e.type = v.type AND e.name = v.name
        WHERE e.publisher = ?1 AND v.state != 'blocked'
          AND v.type || '/' || v.name || '/' || v.version > ?2
        ORDER BY item LIMIT ?3`,
    )
    .bind(publisher, after, limit)
    .all<{ item: string; size: number }>();
  return results;
}

/**
 * Carries the publisher's reconcile pass on while `budget` lasts, starting one at `now` if none
 * is in progress. True when the pass finished.
 */
export async function reconcileUsage(
  dbs: Databases,
  publisher: string,
  now: number,
  budget: UsageBudget = { versions: 1_000 },
): Promise<boolean> {
  const db = dbs.publishers;
  await db
    .prepare("INSERT INTO usage_passes (publisher, started) VALUES (?1, ?2) ON CONFLICT DO NOTHING")
    .bind(publisher, now)
    .run();
  const read = await db
    .prepare("SELECT started, catalogue, after FROM usage_passes WHERE publisher = ?1")
    .bind(publisher)
    .first<Pass>();
  if (!read) return false;
  const pass = { ...read };
  const settled = pass.started - chargeGraceMs;
  const ours = "publisher = ?1 AND started = ?2";
  while (pass.catalogue < dbs.catalogues.length) {
    if (budget.versions <= 0) return false;
    const catalogue = dbs.catalogues[pass.catalogue];
    if (!catalogue) break;
    const limit = Math.min(budget.versions, pageSize);
    const page = await versionPage(catalogue.db, publisher, pass.after, limit);
    budget.versions -= page.length;
    if (page.length < limit) {
      pass.catalogue += 1;
      pass.after = "";
    } else pass.after = page.at(-1)?.item ?? pass.after;
    await db.batch([
      db
        .prepare(
          `INSERT INTO charges (item, publisher, size, at, seen)
            SELECT json_extract(value, '$.item'), ?1, json_extract(value, '$.size'), 0, ?2
              FROM json_each(?4) WHERE EXISTS (SELECT 1 FROM usage_passes WHERE ${ours})
            ON CONFLICT (item) DO UPDATE SET publisher = excluded.publisher,
              size = CASE WHEN charges.at < ?3 THEN excluded.size ELSE charges.size END,
              seen = excluded.seen`,
        )
        .bind(publisher, pass.started, settled, JSON.stringify(page)),
      db
        .prepare(`UPDATE usage_passes SET catalogue = ?3, after = ?4 WHERE ${ours}`)
        .bind(publisher, pass.started, pass.catalogue, pass.after),
    ]);
  }
  // Every catalogue read: drop what this pass never saw, and close it.
  await db.batch([
    db
      .prepare(
        `DELETE FROM charges WHERE publisher = ?1 AND at < ?3 AND (seen IS NULL OR seen != ?2)
          AND EXISTS (SELECT 1 FROM usage_passes WHERE ${ours})`,
      )
      .bind(publisher, pass.started, settled),
    // A mark set after the pass started stays, for the next pass.
    db
      .prepare(
        `UPDATE publishers SET usage_checked = ?3,
            usage_dirty = CASE WHEN usage_dirty <= ?2 THEN NULL ELSE usage_dirty END
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM usage_passes WHERE ${ours})`,
      )
      .bind(publisher, pass.started, now),
    db.prepare(`DELETE FROM usage_passes WHERE ${ours}`).bind(publisher, pass.started),
  ]);
  return true;
}

/**
 * The cron's step, on its own budget: passes in progress, then marked publishers whose mark has
 * settled, then the longest unchecked.
 */
export async function reconcileDue(
  dbs: Databases,
  now: number,
  limits: { marked: number; sweep: number; versions: number },
): Promise<void> {
  const db = dbs.publishers;
  const [running, marked, sweep] = await Promise.all([
    db
      .prepare("SELECT publisher AS id FROM usage_passes ORDER BY started LIMIT ?1")
      .bind(limits.marked)
      .all<{ id: string }>(),
    db
      .prepare(
        `SELECT id FROM publishers WHERE usage_dirty IS NOT NULL AND usage_dirty < ?1
          ORDER BY usage_dirty LIMIT ?2`,
      )
      .bind(now - chargeGraceMs, limits.marked)
      .all<{ id: string }>(),
    db
      .prepare("SELECT id FROM publishers ORDER BY usage_checked LIMIT ?1")
      .bind(limits.sweep)
      .all<{ id: string }>(),
  ]);
  const budget = { versions: limits.versions };
  const ids = new Set([...running.results, ...marked.results, ...sweep.results].map((r) => r.id));
  for (const id of ids) {
    if (budget.versions <= 0) return;
    await reconcileUsage(dbs, id, now, budget);
  }
}
