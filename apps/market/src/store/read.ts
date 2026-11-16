import type { MarketCategory } from "@ace/protocol/marketplace";
import type { EntryRow, StoredVersion } from "../rules.ts";
import { entryRow, signedOf, storedVersion, type EntryJoined, type VersionTable } from "./rows.ts";

/* What the read routes and pages need from D1. */

const joined = `SELECT e.*, p.id AS publisher_id, p.name AS publisher_name,
  (SELECT COALESCE(SUM(v.downloads), 0) FROM versions v WHERE v.type = e.type AND v.name = e.name)
    AS downloads
  FROM entries e JOIN publishers p ON p.id = e.publisher`;

export async function currentStamp(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'stamp'").first<{
    value: number;
  }>();
  return row?.value ?? 0;
}

/** Listed entries, or those changed after `since`. */
export async function listedEntries(db: D1Database, since?: number): Promise<EntryRow[]> {
  const statement =
    since === undefined
      ? db.prepare(`${joined} WHERE e.listed = 1 ORDER BY e.type, e.name`)
      : db
          .prepare(`${joined} WHERE e.listed = 1 AND e.updated > ?1 ORDER BY e.type, e.name`)
          .bind(since);
  const { results } = await statement.all<EntryJoined>();
  return results.map(entryRow);
}

export async function removedSince(
  db: D1Database,
  since: number,
): Promise<{ type: string; name: string }[]> {
  const { results } = await db
    .prepare("SELECT type, name FROM removals WHERE stamp > ?1 ORDER BY type, name")
    .bind(since)
    .all<{ type: string; name: string }>();
  return results.map((row) => ({ type: row.type, name: row.name }));
}

export async function findEntry(
  db: D1Database,
  type: string,
  name: string,
): Promise<EntryRow | undefined> {
  const row = await db
    .prepare(`${joined} WHERE e.type = ?1 AND e.name = ?2`)
    .bind(type, name)
    .first<EntryJoined>();
  return row ? entryRow(row) : undefined;
}

export async function versionsOf(
  db: D1Database,
  type: string,
  name: string,
): Promise<StoredVersion[]> {
  const { results } = await db
    .prepare("SELECT * FROM versions WHERE type = ?1 AND name = ?2")
    .bind(type, name)
    .all<VersionTable>();
  return results.map(storedVersion);
}

/** A signed version's manifest and review mark, as stored. */
export async function signedVersion(
  db: D1Database,
  key: { type: string; name: string; version: string },
) {
  const row = await db
    .prepare(
      "SELECT manifest, review FROM versions WHERE type = ?1 AND name = ?2 AND version = ?3 AND listed = 1",
    )
    .bind(key.type, key.name, key.version)
    .first<{ manifest: string | null; review: string | null }>();
  if (!row?.manifest) return undefined;
  return {
    manifest: signedOf(row.manifest),
    ...(row.review ? { review: signedOf(row.review) } : {}),
  };
}

/** Whether a signed version has these bytes: only those are served to readers. */
export async function hashIsListed(db: D1Database, hash: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM versions WHERE hash = ?1 AND listed = 1 LIMIT 1")
    .bind(hash)
    .first<{ found: number }>();
  return row !== null;
}

/** One more download for the signed versions with these bytes. */
export async function countDownload(db: D1Database, hash: string): Promise<void> {
  await db
    .prepare("UPDATE versions SET downloads = downloads + 1 WHERE hash = ?1 AND listed = 1")
    .bind(hash)
    .run();
}

export async function categories(db: D1Database): Promise<MarketCategory[]> {
  const { results } = await db
    .prepare("SELECT id, title FROM categories ORDER BY position")
    .all<MarketCategory>();
  return results.map((row) => ({ id: row.id, title: row.title }));
}

export async function featured(db: D1Database): Promise<{ type: string; name: string }[]> {
  const { results } = await db
    .prepare("SELECT type, name FROM featured ORDER BY position")
    .all<{ type: string; name: string }>();
  return results.map((row) => ({ type: row.type, name: row.name }));
}

export async function withdrawnList(db: D1Database) {
  const row = await db
    .prepare("SELECT issued, signed FROM withdrawn WHERE id = 1")
    .first<{ issued: number; signed: string }>();
  return row ? { issued: row.issued, signed: signedOf(row.signed) } : undefined;
}
