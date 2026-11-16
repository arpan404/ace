import type { MarketCategory, MarketPublisher, MarketEntryType } from "@ace/protocol/marketplace";
import type { PendingVersion, PendingWithdrawal } from "@ace/marketplace";
import { refreshEntry } from "./entries.ts";

/* The signer's side of D1: what waits for it, and what it signed. */

interface PendingRow {
  type: MarketEntryType;
  name: string;
  version: string;
  hash: string;
  size: number;
  published: number;
  publisher_id: string;
  publisher_name: string;
}

export async function pendingVersions(db: D1Database): Promise<PendingVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT v.type, v.name, v.version, v.hash, v.size, v.published,
          p.id AS publisher_id, p.name AS publisher_name
        FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
        JOIN publishers p ON p.id = e.publisher
        WHERE v.listed = 0 ORDER BY v.published LIMIT 500`,
    )
    .all<PendingRow>();
  return results.map((row) => ({
    type: row.type,
    name: row.name,
    version: row.version,
    hash: row.hash,
    size: row.size,
    published: row.published,
    publisher: { id: row.publisher_id, name: row.publisher_name },
  }));
}

export async function pendingWithdrawals(db: D1Database): Promise<PendingWithdrawal[]> {
  const { results } = await db
    .prepare(
      "SELECT type, name, version, hash, reason, at FROM pending_withdrawals ORDER BY at LIMIT 500",
    )
    .all<PendingWithdrawal>();
  return results;
}

/** A stored version with its entry's publisher, signed or not. */
export async function versionForSigning(
  db: D1Database,
  key: { type: string; name: string; version: string },
): Promise<{ hash: string; size: number; publisher: MarketPublisher } | undefined> {
  const row = await db
    .prepare(
      `SELECT v.hash, v.size, p.id AS publisher_id, p.name AS publisher_name
        FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
        JOIN publishers p ON p.id = e.publisher
        WHERE v.type = ?1 AND v.name = ?2 AND v.version = ?3`,
    )
    .bind(key.type, key.name, key.version)
    .first<{ hash: string; size: number; publisher_id: string; publisher_name: string }>();
  return row
    ? {
        hash: row.hash,
        size: row.size,
        publisher: { id: row.publisher_id, name: row.publisher_name },
      }
    : undefined;
}

export async function hashIsStored(db: D1Database, hash: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM versions WHERE hash = ?1 LIMIT 1")
    .bind(hash)
    .first<{ found: number }>();
  return row !== null;
}

type Key = { type: string; name: string; version: string };

export async function listVersion(db: D1Database, key: Key, manifest: string, now: number) {
  await db
    .prepare(
      "UPDATE versions SET listed = 1, manifest = ?4 WHERE type = ?1 AND name = ?2 AND version = ?3",
    )
    .bind(key.type, key.name, key.version, manifest)
    .run();
  await refreshEntry(db, key.type, key.name, now);
}

export async function setReview(
  db: D1Database,
  key: Key,
  review: { signed: string; reviewed: boolean; byAce: boolean },
  now: number,
) {
  await db
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
    )
    .run();
  await refreshEntry(db, key.type, key.name, now);
}

/**
 * Stores the signed withdrawn list if it is newer than the stored one, and marks every version
 * by it: withdrawn with its reason when listed, not withdrawn otherwise. Returns false for an
 * older list.
 */
export async function setWithdrawn(
  db: D1Database,
  list: { issued: number; signed: string; reasons: ReadonlyMap<string, string> },
  now: number,
): Promise<boolean> {
  const stored = await db
    .prepare(
      `INSERT INTO withdrawn (id, issued, signed) VALUES (1, ?1, ?2)
        ON CONFLICT (id) DO UPDATE SET issued = excluded.issued, signed = excluded.signed
        WHERE excluded.issued > withdrawn.issued`,
    )
    .bind(list.issued, list.signed)
    .run();
  if (stored.meta.changes !== 1) return false;
  const hashes = JSON.stringify([...list.reasons.keys()]);
  const { results } = await db
    .prepare(
      `SELECT type, name, version, hash, withdrawn FROM versions
        WHERE withdrawn IS NOT NULL OR hash IN (SELECT value FROM json_each(?1))`,
    )
    .bind(hashes)
    .all<Key & { hash: string; withdrawn: string | null }>();
  const changed = results.filter((row) => (list.reasons.get(row.hash) ?? null) !== row.withdrawn);
  if (changed.length > 0)
    await db.batch(
      changed.map((row) =>
        db
          .prepare(
            "UPDATE versions SET withdrawn = ?4 WHERE type = ?1 AND name = ?2 AND version = ?3",
          )
          .bind(row.type, row.name, row.version, list.reasons.get(row.hash) ?? null),
      ),
    );
  await db
    .prepare("DELETE FROM pending_withdrawals WHERE hash IN (SELECT value FROM json_each(?1))")
    .bind(hashes)
    .run();
  const entries = new Map(changed.map((row) => [`${row.type}/${row.name}`, row]));
  for (const row of entries.values()) await refreshEntry(db, row.type, row.name, now);
  return true;
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

/** Which of `list` are listed and reviewed now. */
export async function reviewedEntries(
  db: D1Database,
  list: readonly { type: string; name: string }[],
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT type, name FROM entries WHERE listed = 1 AND reviewed = 1
        AND (type || '/' || name) IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(list.map((entry) => `${entry.type}/${entry.name}`)))
    .all<{ type: string; name: string }>();
  return new Set(results.map((row) => `${row.type}/${row.name}`));
}
