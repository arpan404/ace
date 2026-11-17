import { eachCatalogue, type Databases } from "./databases.ts";
import { refreshEntry, stampValue, takeStamp } from "./entries.ts";

/*
 * Each catalogue's copy of the publishers it names (ADR 0173 §16). An entry's row depends on
 * its publisher's handle, state and verified mark, which the publishers database owns. That
 * database moves a publisher's `revision` in the statement that changes any of them (a trigger)
 * and keeps `synced`, the revision every catalogue has applied. Applying a copy writes it only
 * when its revision is newer, and in the same batch moves the generation of every entry of that
 * publisher and restamps its listed ones: a refresh that read the old copy can't write it back,
 * and `since` readers see the new handle. `synced` moves only after every catalogue applied it,
 * and only forward; the cron applies every copy that is behind.
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

/**
 * Writes the copy into one catalogue if it is newer than the one there, then brings the
 * publisher's entries in step, whether or not this call wrote it: a sync cut off between the two
 * is finished by the next one. True when this call wrote the copy.
 */
export async function applyCopy(
  db: D1Database,
  copy: PublisherCopy,
  now: number,
): Promise<boolean> {
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
    // Only when the copy above was written by this batch: its applied stamp is this one.
    db
      .prepare(
        `UPDATE entries SET generation = generation + 1,
            updated = CASE WHEN listed = 1 THEN ${stampValue} ELSE updated END
          WHERE publisher = ?1 AND EXISTS (SELECT 1 FROM publisher_copies
            WHERE id = ?1 AND applied_stamp = ${stampValue})`,
      )
      .bind(copy.id),
  ]);
  const { results } = await db
    .prepare("SELECT type, name FROM entries WHERE publisher = ?1")
    .bind(copy.id)
    .all<{ type: string; name: string }>();
  for (const row of results) await refreshEntry(db, row.type, row.name, now);
  return (written?.meta.changes ?? 0) > 0;
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
  if (copy) await applyCopy(db, copy, now);
}

/** Applies the publisher's copy in every catalogue, then records it synced. */
export async function syncPublisher(dbs: Databases, id: string, now: number): Promise<void> {
  const copy = await copyOf(dbs.publishers, id);
  if (!copy) return;
  await eachCatalogue(dbs, ({ db }) => applyCopy(db, copy, now));
  await dbs.publishers
    .prepare("UPDATE publishers SET synced = ?2 WHERE id = ?1 AND synced < ?2")
    .bind(id, copy.revision)
    .run();
}

/** The cron's step: every publisher whose copies are behind, a bounded batch. */
export async function syncDue(dbs: Databases, now: number, limit: number): Promise<number> {
  const { results } = await dbs.publishers
    .prepare("SELECT id FROM publishers WHERE synced < revision LIMIT ?1")
    .bind(limit)
    .all<{ id: string }>();
  for (const row of results) await syncPublisher(dbs, row.id, now);
  return results.length;
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
