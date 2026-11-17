import { eachCatalogue, type Databases } from "./databases.ts";
import { refreshEntry, stampValue, takeStamp } from "./entries.ts";

/*
 * Each catalogue's copy of the publishers it names (ADR 0173 §16). An entry's row depends on
 * its publisher's handle, state and verified mark, which the publishers database owns. That
 * database moves a publisher's `revision` in the statement that changes any of them (a trigger)
 * and keeps `synced`, the revision every catalogue has applied. Applying a copy writes it only
 * when its revision is newer, and in the same batch moves the generation of every entry of that
 * publisher, restamps its listed ones and records the refresh owed: a refresh that read the old
 * copy can't write it back, and `since` readers see the new handle. The entries are then
 * refreshed in bounded pages under a persisted cursor. `synced` moves only after every catalogue
 * applied it and owes no refresh, and only forward; the cron carries on every copy behind.
 */

export interface PublisherCopy {
  id: string;
  name: string;
  state: string;
  verified: number;
  created: number;
  revision: number;
}

/** The copy as the publishers database holds it now. */
export async function copyOf(
  publishers: D1Database,
  id: string,
): Promise<PublisherCopy | undefined> {
  return (
    (await publishers
      .prepare("SELECT id, name, state, verified, created, revision FROM publishers WHERE id = ?1")
      .bind(id)
      .first<PublisherCopy>()) ?? undefined
  );
}

/** How many entries a copy's refresh may bring in step, shared by the pages that spend it. */
export interface RefreshBudget {
  entries: number;
}

/** The most entries one page reads. */
const pageSize = 100;

/**
 * Writes the copy into one catalogue if it is newer than the one there, in one batch that also
 * moves the generation of the publisher's entries, restamps its listed ones and records the
 * refresh still owed for this revision (`copy_refreshes`, from the first entry). True when this
 * call wrote the copy. The refresh itself is `refreshCopy`, a page at a time.
 */
export async function applyCopy(
  db: D1Database,
  copy: PublisherCopy,
  now: number,
): Promise<boolean> {
  // Statements after the copy act only when this batch wrote it: its applied stamp is this one.
  const applied = `EXISTS (SELECT 1 FROM publisher_copies WHERE id = ?1
    AND applied_stamp = ${stampValue})`;
  const [, written] = await db.batch([
    takeStamp(db, now),
    db
      .prepare(
        `INSERT INTO publisher_copies (id, name, state, verified, created, revision, applied_stamp)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${stampValue})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, state = excluded.state,
            verified = excluded.verified, created = excluded.created,
            revision = excluded.revision, applied_stamp = excluded.applied_stamp
          WHERE excluded.revision > publisher_copies.revision`,
      )
      .bind(copy.id, copy.name, copy.state, copy.verified, copy.created, copy.revision),
    db
      .prepare(
        `UPDATE entries SET generation = generation + 1,
            updated = CASE WHEN listed = 1 THEN ${stampValue} ELSE updated END
          WHERE publisher = ?1 AND ${applied}`,
      )
      .bind(copy.id),
    db
      .prepare(
        `INSERT INTO copy_refreshes (publisher, revision, after) SELECT ?1, ?2, '' WHERE ${applied}
          ON CONFLICT (publisher) DO UPDATE SET revision = excluded.revision, after = ''`,
      )
      .bind(copy.id, copy.revision),
  ]);
  return (written?.meta.changes ?? 0) > 0;
}

/**
 * Brings the publisher's entries in one catalogue in step with its copy, a page at a time from
 * the persisted cursor, while `budget` lasts. The cursor moves only while it is still for the
 * revision read, and is removed when the last page of that revision is done, so a refresh cut off
 * anywhere carries on where it stopped and a newer copy starts over. True when nothing is owed.
 */
export async function refreshCopy(
  db: D1Database,
  publisher: string,
  budget: RefreshBudget,
  now: number,
): Promise<boolean> {
  for (;;) {
    const cursor = await db
      .prepare("SELECT revision, after FROM copy_refreshes WHERE publisher = ?1")
      .bind(publisher)
      .first<{ revision: number; after: string }>();
    if (!cursor) return true;
    if (budget.entries <= 0) return false;
    const limit = Math.min(budget.entries, pageSize);
    const { results } = await db
      .prepare(
        "SELECT type, name FROM entries WHERE publisher = ?1 AND name > ?2 ORDER BY name LIMIT ?3",
      )
      .bind(publisher, cursor.after, limit)
      .all<{ type: string; name: string }>();
    for (const row of results) await refreshEntry(db, row.type, row.name, now);
    budget.entries -= results.length;
    const last = results.at(-1)?.name;
    await (
      results.length < limit
        ? db
            .prepare("DELETE FROM copy_refreshes WHERE publisher = ?1 AND revision = ?2")
            .bind(publisher, cursor.revision)
        : db
            .prepare("UPDATE copy_refreshes SET after = ?3 WHERE publisher = ?1 AND revision = ?2")
            .bind(publisher, cursor.revision, last ?? cursor.after)
    ).run();
  }
}

/** Makes sure one catalogue has a copy of the publisher before a row there names it. */
export async function ensureCopy(
  dbs: Pick<Databases, "publishers">,
  db: D1Database,
  publisher: string,
  now: number,
): Promise<void> {
  const present = await db
    .prepare("SELECT 1 AS found FROM publisher_copies WHERE id = ?1")
    .bind(publisher)
    .first();
  if (present) return;
  const copy = await copyOf(dbs.publishers, publisher);
  if (!copy) return;
  await applyCopy(db, copy, now);
  // A new copy names no entry yet: its refresh is one empty page.
  await refreshCopy(db, publisher, { entries: pageSize }, now);
}

/**
 * Applies the publisher's copy in every catalogue and refreshes its entries while `budget`
 * lasts; records it synced only when every catalogue owes nothing for this revision. False when
 * work is left for the cron.
 */
export async function syncPublisher(
  dbs: Databases,
  id: string,
  now: number,
  budget: RefreshBudget = { entries: 500 },
): Promise<boolean> {
  const copy = await copyOf(dbs.publishers, id);
  if (!copy) return true;
  let done = true;
  for (const { db } of dbs.catalogues) {
    await applyCopy(db, copy, now);
    if (!(await refreshCopy(db, id, budget, now))) done = false;
  }
  if (!done) return false;
  await dbs.publishers
    .prepare("UPDATE publishers SET synced = ?2 WHERE id = ?1 AND synced < ?2")
    .bind(id, copy.revision)
    .run();
  return true;
}

/**
 * The cron's step: publishers whose copies are behind, a bounded batch sharing one budget of
 * entries, so one publisher with many entries spends this step's budget and no other step's.
 */
export async function syncDue(
  dbs: Databases,
  now: number,
  budget: { publishers: number; entries: number },
): Promise<void> {
  const { results } = await dbs.publishers
    .prepare("SELECT id FROM publishers WHERE synced < revision LIMIT ?1")
    .bind(budget.publishers)
    .all<{ id: string }>();
  const entries = { entries: budget.entries };
  for (const row of results) {
    if (entries.entries <= 0) return;
    await syncPublisher(dbs, row.id, now, entries);
  }
}

/** How many of the publisher's versions ever went live, over every catalogue (§9). */
export async function liveVersionsOf(dbs: Databases, publisher: string): Promise<number> {
  const counts = await eachCatalogue(dbs, ({ db }) =>
    db
      .prepare("SELECT live_versions AS count FROM publisher_copies WHERE id = ?1")
      .bind(publisher)
      .first<{ count: number }>(),
  );
  return counts.reduce((sum, row) => sum + (row?.count ?? 0), 0);
}
