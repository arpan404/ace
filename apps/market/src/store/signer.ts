import type { MarketCategory, MarketPublisher, MarketEntryType } from "@ace/protocol/marketplace";
import { withdrawalReason } from "@ace/marketplace";
import {
  type PendingVersion,
  type PendingWithdrawal,
  type Withdrawal,
} from "@ace/protocol/marketplace";
import { eachCatalogue, fromCatalogues, type Databases } from "./databases.ts";
import { bumpGeneration, refreshEntry } from "./entries.ts";
import { listOutcome, upsertSigned, type ListStored } from "./lists.ts";
import { withdrawnBodyOf } from "./rows.ts";

/*
 * The signer's side of D1: what waits for it, over every catalogue, and what it signed. A
 * version's own changes stay in its type's catalogue, batched with its entry's generation.
 */

interface PendingRow {
  type: MarketEntryType;
  name: string;
  version: string;
  hash: string;
  size: number;
  published: number;
  publisher_id: string;
  publisher_name: string;
  approved: number;
}

const pendingLimit = 500;

/**
 * Versions waiting for a signer: the market's (`public`), or one organization's registry's
 * (`org:<id>`), which only that registry's signer signs (ADR 0206 §5.2).
 */
export async function pendingVersions(
  dbs: Databases,
  audience = "public",
): Promise<PendingVersion[]> {
  const rows = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT v.type, v.name, v.version, v.hash, v.size, v.published, v.approved,
            p.id AS publisher_id, p.name AS publisher_name
          FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
          JOIN publisher_copies p ON p.id = e.publisher
          WHERE v.state = 'pending' AND v.listed = 0 AND e.audience = ?1
          ORDER BY v.published LIMIT ${pendingLimit}`,
      )
      .bind(audience)
      .all<PendingRow>();
    return results;
  });
  const oldest = rows.toSorted((a, b) => a.published - b.published).slice(0, pendingLimit);
  return oldest.map((row) => {
    const pending: PendingVersion = {
      type: row.type,
      name: row.name,
      version: row.version,
      hash: row.hash,
      size: row.size,
      published: row.published,
      publisher: { id: row.publisher_id, name: row.publisher_name },
    };
    if (row.approved === 1) pending.approved = true;
    return pending;
  });
}

export async function pendingWithdrawals(dbs: Databases): Promise<PendingWithdrawal[]> {
  const rows = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT w.type, w.name, w.version, w.hash, w.reason, w.at FROM pending_withdrawals w
          JOIN entries e ON e.type = w.type AND e.name = w.name
          WHERE e.audience = 'public' ORDER BY w.at LIMIT ${pendingLimit}`,
      )
      .all<PendingWithdrawal>();
    return results;
  });
  return rows.toSorted((a, b) => a.at - b.at).slice(0, pendingLimit);
}

/** A stored version with its entry's publisher, signed or not. */
export async function versionForSigning(
  db: D1Database,
  key: { type: string; name: string; version: string },
): Promise<
  | { hash: string; size: number; state: string; publisher: MarketPublisher; audience: string }
  | undefined
> {
  const row = await db
    .prepare(
      `SELECT v.hash, v.size, v.state, e.audience, p.id AS publisher_id, p.name AS publisher_name
        FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
        JOIN publisher_copies p ON p.id = e.publisher
        WHERE v.type = ?1 AND v.name = ?2 AND v.version = ?3`,
    )
    .bind(key.type, key.name, key.version)
    .first<{
      hash: string;
      size: number;
      state: string;
      audience: string;
      publisher_id: string;
      publisher_name: string;
    }>();
  return row
    ? {
        hash: row.hash,
        size: row.size,
        state: row.state,
        audience: row.audience,
        publisher: { id: row.publisher_id, name: row.publisher_name },
      }
    : undefined;
}

/**
 * Whether any catalogue stores a version with these bytes for `audience`, listed or not: ace's
 * signer reads the public market's bytes, a registry's signer its own.
 */
export async function hashIsStored(
  dbs: Databases,
  hash: string,
  audience: string,
): Promise<boolean> {
  const found = await eachCatalogue(dbs, ({ db }) =>
    db
      .prepare(
        `SELECT 1 AS found FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE v.hash = ?1 AND e.audience = ?2 LIMIT 1`,
      )
      .bind(hash, audience)
      .first(),
  );
  return found.some((row) => row !== null);
}

type Key = { type: string; name: string; version: string };

/**
 * Lists a signed version. The first time it goes live its publisher's count of live versions in
 * this catalogue moves (ADR 0174 §9) and its entry's first listing is set, in the same batch. Every statement
 * re-checks that the version is still pending (or already listed, for a signature sent again),
 * so a hold or block a maintainer made after the route read it stands, and that the version
 * still names the bytes and publisher the manifest was checked against: a version blocked and
 * submitted again with other bytes after the route read it never takes the old manifest. False
 * when it no longer waits for the signer or names other bytes.
 */
export async function listVersion(
  db: D1Database,
  key: Key,
  signed: { manifest: string; hash: string; size: number; publisher: string },
  now: number,
): Promise<boolean> {
  const same = `hash = ?5 AND size = ?6
    AND (SELECT publisher FROM entries WHERE type = ?1 AND name = ?2) = ?7`;
  const unlisted = `EXISTS (SELECT 1 FROM versions WHERE type = ?1 AND name = ?2 AND version = ?3
    AND listed = 0 AND state = 'pending' AND ${same})`;
  const bound = [signed.manifest, signed.hash, signed.size, signed.publisher] as const;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE publisher_copies SET live_versions = live_versions + 1
          WHERE id = (SELECT publisher FROM entries WHERE type = ?1 AND name = ?2) AND ${unlisted}`,
      )
      .bind(key.type, key.name, key.version, ...bound),
    db
      .prepare(
        `UPDATE entries SET first_listed = COALESCE(first_listed, ?8)
          WHERE type = ?1 AND name = ?2 AND ${unlisted}`,
      )
      .bind(key.type, key.name, key.version, ...bound, now),
    db
      .prepare(
        `UPDATE versions SET listed = 1, state = 'listed', manifest = ?4
          WHERE type = ?1 AND name = ?2 AND version = ?3 AND state IN ('pending', 'listed')
          AND ${same}`,
      )
      .bind(key.type, key.name, key.version, ...bound),
    bumpGeneration(db, key.type, key.name),
  ]);
  if ((results[2]?.meta.changes ?? 0) === 0) return false;
  await refreshEntry(db, key.type, key.name, now);
  return true;
}

export async function setReview(
  db: D1Database,
  key: Key,
  review: { signed: string; reviewed: boolean; byAce: boolean },
  now: number,
) {
  await db.batch([
    db
      .prepare(
        `UPDATE versions SET review = ?4, reviewed = ?5, by_ace = ?6
          WHERE type = ?1 AND name = ?2 AND version = ?3`,
      )
      .bind(
        key.type,
        key.name,
        key.version,
        review.signed,
        review.reviewed ? 1 : 0,
        review.byAce ? 1 : 0,
      ),
    bumpGeneration(db, key.type, key.name),
  ]);
  await refreshEntry(db, key.type, key.name, now);
}

/**
 * Stores the signed withdrawn list in the lists database, only when it is newer than, and based
 * on, the stored one, so two maintainers' edits never undo each other; then marks every
 * catalogue's versions by it (`applyWithdrawn`). Sending the stored list again marks again,
 * which is how an upload cut off part way carries on; the cron does the same for any catalogue
 * still behind the stored list.
 */
export async function setWithdrawn(
  dbs: Databases,
  list: {
    issued: number;
    signed: string;
    withdrawn: readonly Withdrawal[];
    basedOn?: number | undefined;
  },
  now: number,
): Promise<ListStored> {
  await upsertSigned(dbs.lists, "withdrawn", list).run();
  const outcome = await listOutcome(dbs.lists, "withdrawn", list);
  if (outcome !== "stored") return outcome;
  await eachCatalogue(dbs, ({ db }) => applyWithdrawn(db, list, now));
  return outcome;
}

/**
 * Marks one catalogue's versions by a withdrawn list the lists database stored, in one batch:
 * the list is recorded as this catalogue's applied one (only if it isn't older), every entry the
 * marks touch is queued for a refresh, generations move and the marks are set, each statement
 * after the first applying only while this very list is the applied one, so an older list
 * applied late changes nothing. Then the queue is drained. A cut-off anywhere after the batch
 * leaves the queue, which the cron drains (`applyWithdrawnDue`); applying the same list again
 * does it all again.
 */
export async function applyWithdrawn(
  db: D1Database,
  list: { issued: number; withdrawn: readonly Withdrawal[] },
  now: number,
): Promise<void> {
  const hashes = JSON.stringify([...new Set(list.withdrawn.map((entry) => entry.hash))]);
  const { results: before } = await db
    .prepare(
      `SELECT type, name, version, hash FROM versions
        WHERE withdrawn IS NOT NULL OR hash IN (SELECT value FROM json_each(?1))`,
    )
    .bind(hashes)
    .all<Key & { hash: string }>();
  const marks = before.flatMap((row) => {
    const reason = withdrawalReason(list.withdrawn, row);
    return reason ? [{ key: `${row.type}/${row.name}@${row.version}`, reason }] : [];
  });
  const guard = "(SELECT issued = ?1 FROM applied_lists WHERE name = 'withdrawn')";
  const touched = `withdrawn IS NOT NULL OR hash IN (SELECT value FROM json_each(?2))`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO applied_lists (name, issued) VALUES ('withdrawn', ?1)
          ON CONFLICT (name) DO UPDATE SET issued = excluded.issued
          WHERE excluded.issued > applied_lists.issued`,
      )
      .bind(list.issued),
    // Before the marks move: the entries they touch now, and those they touched before.
    db
      .prepare(
        `INSERT INTO refresh_queue (type, name)
          SELECT DISTINCT type, name FROM versions WHERE ${guard} AND (${touched})
          ON CONFLICT (type, name) DO UPDATE SET queued = queued + 1`,
      )
      .bind(list.issued, hashes),
    db
      .prepare(
        `UPDATE entries SET generation = generation + 1 WHERE ${guard} AND EXISTS (
          SELECT 1 FROM versions v WHERE v.type = entries.type AND v.name = entries.name
            AND (v.withdrawn IS NOT NULL OR v.hash IN (SELECT value FROM json_each(?2))))`,
      )
      .bind(list.issued, hashes),
    db
      .prepare(
        `UPDATE versions SET withdrawn = (
            SELECT json_extract(m.value, '$.reason') FROM json_each(?2) m
            WHERE json_extract(m.value, '$.key') = versions.type || '/' || versions.name || '@' || versions.version)
          WHERE ${guard} AND (withdrawn IS NOT NULL OR hash IN (SELECT value FROM json_each(?3)))`,
      )
      .bind(list.issued, JSON.stringify(marks), hashes),
    db
      .prepare(
        `DELETE FROM pending_withdrawals WHERE ${guard} AND (type || '/' || name || '@' || version)
          IN (SELECT json_extract(value, '$.key') FROM json_each(?2))`,
      )
      .bind(list.issued, JSON.stringify(marks)),
  ]);
  await drainWithdrawn(db, now, refreshBatch);
}

/** Entries a refresh step brings in step at most, per catalogue. */
const refreshBatch = 500;

/**
 * Refreshes up to `limit` queued entries; a row goes only while it wasn't queued again during
 * its refresh. When the queue is empty, the applied list is recorded as fully refreshed. True
 * when this pass reached the end of the queue.
 */
export async function drainWithdrawn(db: D1Database, now: number, limit: number) {
  const { results } = await db
    .prepare("SELECT type, name, queued FROM refresh_queue LIMIT ?1")
    .bind(limit)
    .all<{ type: string; name: string; queued: number }>();
  for (const row of results) {
    await refreshEntry(db, row.type, row.name, now);
    await db
      .prepare("DELETE FROM refresh_queue WHERE type = ?1 AND name = ?2 AND queued = ?3")
      .bind(row.type, row.name, row.queued)
      .run();
  }
  if (results.length === limit) return false;
  // The completion cursor moves only while the queue is empty, checked in the statement.
  await db
    .prepare(
      `INSERT INTO applied_lists (name, issued)
        SELECT 'withdrawn:refreshed', issued FROM applied_lists
          WHERE name = 'withdrawn' AND NOT EXISTS (SELECT 1 FROM refresh_queue)
        ON CONFLICT (name) DO UPDATE SET issued = MAX(applied_lists.issued, excluded.issued)`,
    )
    .run();
  return true;
}

/** The `issued` of the withdrawn list a catalogue last marked (or fully refreshed) by. */
export async function appliedWithdrawn(
  db: D1Database,
  stage: "withdrawn" | "withdrawn:refreshed" = "withdrawn",
): Promise<number | undefined> {
  const row = await db
    .prepare("SELECT issued FROM applied_lists WHERE name = ?1")
    .bind(stage)
    .first<{ issued: number }>();
  return row?.issued;
}

/**
 * The cron's step: marks every catalogue still behind the stored withdrawn list by it, and
 * drains every catalogue's queue of entries its marks touched, so a refresh cut off after the
 * marks committed is finished (ADR 0174 §16).
 */
export async function applyWithdrawnDue(dbs: Databases, now: number): Promise<void> {
  const stored = await dbs.lists
    .prepare("SELECT issued, signed FROM withdrawn WHERE id = 1")
    .first<{ issued: number; signed: string }>();
  await eachCatalogue(dbs, async ({ db }) => {
    const [marked, refreshed] = await Promise.all([
      appliedWithdrawn(db),
      appliedWithdrawn(db, "withdrawn:refreshed"),
    ]);
    if (stored && (marked === undefined || marked < stored.issued)) {
      const body = withdrawnBodyOf(stored.signed);
      await applyWithdrawn(db, { issued: stored.issued, withdrawn: body.withdrawn }, now);
    } else if (marked !== undefined && (refreshed === undefined || refreshed < marked))
      await drainWithdrawn(db, now, refreshBatch);
  });
}

export async function setCategories(db: D1Database, list: readonly MarketCategory[]) {
  await db.batch([
    db.prepare("DELETE FROM categories"),
    ...list.map((category, position) =>
      db
        .prepare("INSERT INTO categories (position, id, title) VALUES (?1, ?2, ?3)")
        .bind(position, category.id, category.title),
    ),
  ]);
}

export async function setFeatured(db: D1Database, list: readonly { type: string; name: string }[]) {
  await db.batch([
    db.prepare("DELETE FROM featured"),
    ...list.map((entry, position) =>
      db
        .prepare("INSERT INTO featured (position, type, name) VALUES (?1, ?2, ?3)")
        .bind(position, entry.type, entry.name),
    ),
  ]);
}

/** Which of `list` are listed and reviewed now, over every catalogue. */
export async function reviewedEntries(
  dbs: Databases,
  list: readonly { type: string; name: string }[],
): Promise<Set<string>> {
  const refs = JSON.stringify(list.map((entry) => `${entry.type}/${entry.name}`));
  const rows = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT type, name FROM entries WHERE listed = 1 AND reviewed = 1
          AND (type || '/' || name) IN (SELECT value FROM json_each(?1))`,
      )
      .bind(refs)
      .all<{ type: string; name: string }>();
    return results;
  });
  return new Set(rows.map((row) => `${row.type}/${row.name}`));
}
