import type { MarketCategory } from "@ace/protocol/marketplace";
import type { EntryRow, StoredVersion } from "../rules.ts";
import { fromCatalogues, type Databases } from "./databases.ts";
import { entryRow, signedOf, storedVersion, type EntryJoined, type VersionTable } from "./rows.ts";

/*
 * What the read routes and pages need from D1. An entry's own reads take its type's catalogue;
 * reads over every entry fan out to each catalogue in parallel (ADR 0174 §16).
 */

// Listings show totals as last folded into the index (`counted`, store/downloads.ts), so what a
// `since` reader holds and what a full read shows agree.
const joined = `SELECT e.*, p.id AS publisher_id, p.name AS publisher_name,
  p.state AS publisher_state, p.verified AS publisher_verified,
  (SELECT COALESCE(SUM(v.counted), 0) FROM versions v WHERE v.type = e.type AND v.name = e.name)
    AS downloads
  FROM entries e JOIN publisher_copies p ON p.id = e.publisher`;

export async function currentStamp(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'stamp'").first<{
    value: number;
  }>();
  return row?.value ?? 0;
}

/**
 * Raises the catalogue's stamp to at least `to`, in one statement, and answers it: the catalogue's
 * next change then takes a stamp above `to` (ADR 0174 §16).
 */
export async function raiseStamp(db: D1Database, to: number): Promise<number> {
  const row = await db
    .prepare("UPDATE meta SET value = MAX(value, ?1) WHERE key = 'stamp' RETURNING value")
    .bind(to)
    .first<{ value: number }>();
  return row?.value ?? to;
}

/**
 * Entries in the index, or those changed after `since`: `listed` means a live version, listed
 * visibility, not archived and an active publisher, so unlisted and archived entries never
 * appear here (ADR 0174 §5).
 */
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

/** Every catalogue's entries in the index, in type order then by name. */
export const listedEverywhere = (dbs: Databases) =>
  fromCatalogues(dbs, ({ db }) => listedEntries(db));

/** One publisher's entries in the index, over every catalogue. */
export async function publisherEntries(dbs: Databases, publisher: string): Promise<EntryRow[]> {
  return fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(`${joined} WHERE e.listed = 1 AND e.publisher = ?1 ORDER BY e.type, e.name`)
      .bind(publisher)
      .all<EntryJoined>();
    return results.map(entryRow);
  });
}

/** The entry's table row with its publisher, listed or not. */
export async function findEntryJoined(
  db: D1Database,
  type: string,
  name: string,
): Promise<EntryJoined | undefined> {
  const row = await db
    .prepare(`${joined} WHERE e.type = ?1 AND e.name = ?2`)
    .bind(type, name)
    .first<EntryJoined>();
  return row ?? undefined;
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

/** A signed version with these bytes, in whichever catalogue holds it. */
export interface ListedCopy {
  type: string;
  name: string;
  version: string;
  published: number;
  /** Who may read it: `public`, or an organization's `org:<id>` (ADR 0206 §5.1). */
  audience: string;
}

/**
 * Every signed version with these bytes, over every catalogue: only those are served to readers,
 * and a download counts for each of them.
 */
export async function listedWithHash(dbs: Databases, hash: string): Promise<ListedCopy[]> {
  return fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT v.type, v.name, v.version, v.published, e.audience FROM versions v
          JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE v.hash = ?1 AND v.listed = 1`,
      )
      .bind(hash)
      .all<ListedCopy>();
    return results;
  });
}

/* The maintainers' lists, in the lists database. */

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
