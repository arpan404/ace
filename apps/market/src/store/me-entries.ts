import type {
  MarketAppeal,
  MarketEntryRef,
  MarketListingEdit,
  MarketOwnEntry,
  MarketOwnEntrySummary,
  MarketOwnVersion,
} from "@ace/protocol/marketplace";
import { objectKey, versionReportKey } from "../context.ts";
import { currentListing, newestFirst, versionStatus, type StoredVersion } from "../rules.ts";
import { bumpGeneration, refreshEntry } from "./entries.ts";
import { getReport } from "./me-scan.ts";
import { unpinStatement } from "./profiles.ts";
import {
  entryManagement,
  pendingListingOf,
  storedVersion,
  type EntryTable,
  type PendingListing,
  type VersionTable,
} from "./rows.ts";

/*
 * A publisher's own entries (ADR 0173 §4, §5): what their page shows, and the settings they
 * change. Every change to an entry's settings moves its generation in the same batch and brings
 * its row in step, so the index and `since` readers follow.
 */

type Key = { type: string; name: string };
type Joined = EntryTable & { publisher_state: string; publisher_verified: number };

export async function ownEntryRow(db: D1Database, key: Key): Promise<Joined | undefined> {
  return (
    (await db
      .prepare(
        `SELECT e.*, p.state AS publisher_state, p.verified AS publisher_verified
          FROM entries e JOIN publishers p ON p.id = e.publisher
          WHERE e.type = ?1 AND e.name = ?2`,
      )
      .bind(key.type, key.name)
      .first<Joined>()) ?? undefined
  );
}

const manageOf = (row: Joined) =>
  entryManagement(row, { state: row.publisher_state, verified: row.publisher_verified });

const ref = (key: Key) => `${key.type}/${key.name}`;

async function openReports(db: D1Database, publisher: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT r.type, r.name, COUNT(*) AS open FROM reports r JOIN entries e
        ON e.type = r.type AND e.name = r.name
        WHERE e.publisher = ?1 AND r.state = 'open' GROUP BY r.type, r.name`,
    )
    .bind(publisher)
    .all<Key & { open: number }>();
  return new Map(results.map((row) => [ref(row), row.open]));
}

function summaryOf(
  row: Joined,
  versions: readonly StoredVersion[],
  pins: ReadonlySet<string>,
  reports: number,
): MarketOwnEntrySummary {
  const manage = manageOf(row);
  const listing = currentListing(row.name, versions, manage);
  const newest = newestFirst(versions)[0];
  return {
    type: row.type as MarketOwnEntrySummary["type"],
    name: row.name,
    title: listing.title,
    line: listing.line,
    ...(newest ? { version: newest.version, status: versionStatus(newest).status } : {}),
    versions: versions.length,
    visibility: manage.visibility,
    archived: manage.archived,
    pinned: pins.has(ref(row)),
    reviewed: row.reviewed === 1,
    downloads: versions.reduce((sum, version) => sum + version.downloads, 0),
    pendingListing: row.pending_listing !== null,
    openReports: reports,
  };
}

/** Every entry of the publisher, as the rows on their page. */
export async function ownEntrySummaries(
  db: D1Database,
  publisher: string,
  pins: readonly MarketEntryRef[],
): Promise<MarketOwnEntrySummary[]> {
  const [entries, versions, reports] = await Promise.all([
    db
      .prepare(
        `SELECT e.*, p.state AS publisher_state, p.verified AS publisher_verified
          FROM entries e JOIN publishers p ON p.id = e.publisher
          WHERE e.publisher = ?1 ORDER BY e.type, e.name LIMIT 500`,
      )
      .bind(publisher)
      .all<Joined>(),
    db
      .prepare(
        `SELECT v.* FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE e.publisher = ?1`,
      )
      .bind(publisher)
      .all<VersionTable>(),
    openReports(db, publisher),
  ]);
  const byEntry = new Map<string, StoredVersion[]>();
  for (const row of versions.results) {
    const list = byEntry.get(ref(row)) ?? [];
    list.push(storedVersion(row));
    byEntry.set(ref(row), list);
  }
  const pinned = new Set(pins.map(ref));
  return entries.results.map((row) =>
    summaryOf(row, byEntry.get(ref(row)) ?? [], pinned, reports.get(ref(row)) ?? 0),
  );
}

interface AppealTable {
  id: string;
  version: string;
  note: string;
  replacement: string | null;
  at: number;
  state: MarketAppeal["state"];
  answer: string | null;
}

/** Everything about one of the publisher's entries. */
export async function ownEntry(
  db: D1Database,
  bucket: R2Bucket,
  row: Joined,
  pins: readonly MarketEntryRef[],
): Promise<MarketOwnEntry> {
  const [versionRows, appeals, reports] = await Promise.all([
    db
      .prepare("SELECT * FROM versions WHERE type = ?1 AND name = ?2")
      .bind(row.type, row.name)
      .all<VersionTable>(),
    db
      .prepare("SELECT * FROM appeals WHERE type = ?1 AND name = ?2 ORDER BY at")
      .bind(row.type, row.name)
      .all<AppealTable>(),
    openReports(db, row.publisher),
  ]);
  const versions = versionRows.results.map(storedVersion);
  const appealOf = new Map(appeals.results.map((appeal) => [appeal.version, appeal]));
  const manage = manageOf(row);
  const own: MarketOwnVersion[] = [];
  for (const version of newestFirst(versions).slice(0, 200)) {
    const status = versionStatus(version);
    const scan = await getReport(bucket, versionReportKey({ ...row, version: version.version }));
    const appeal = appealOf.get(version.version);
    own.push({
      version: version.version,
      hash: version.hash,
      size: version.size,
      published: version.published,
      status: status.status,
      held: status.held,
      ...(status.reason ? { reason: status.reason.slice(0, 500) } : {}),
      ...(version.deprecated ? { deprecated: version.deprecated } : {}),
      changelog: version.changelog ?? "",
      downloads: version.downloads,
      ...(scan ? { scan } : {}),
      ...(appeal
        ? {
            appeal: {
              id: appeal.id,
              note: appeal.note,
              ...(appeal.replacement ? { replacement: appeal.replacement } : {}),
              at: appeal.at,
              state: appeal.state,
              ...(appeal.answer ? { answer: appeal.answer } : {}),
            },
          }
        : {}),
    });
  }
  const pending = pendingListingOf(row);
  return {
    summary: summaryOf(row, versions, new Set(pins.map(ref)), reports.get(ref(row)) ?? 0),
    listing: currentListing(row.name, versions, manage),
    ...(row.latest_pick ? { latest: row.latest_pick } : {}),
    ...(pending ? { pendingListing: pending } : {}),
    versions: own,
  };
}

/** Changes an entry's own columns, moves its generation and brings its row in step. */
async function setEntry(
  db: D1Database,
  key: Key,
  sql: string,
  values: readonly (string | number | null)[],
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE entries SET ${sql} WHERE type = ?1 AND name = ?2`)
      .bind(key.type, key.name, ...values),
    bumpGeneration(db, key.type, key.name),
  ]);
  await refreshEntry(db, key.type, key.name, now);
}

export const setVisibility = (db: D1Database, key: Key, visibility: string, now: number) =>
  setEntry(db, key, "visibility = ?3", [visibility], now);
export const setArchived = (db: D1Database, key: Key, archived: boolean, now: number) =>
  setEntry(db, key, "archived = ?3", [archived ? 1 : 0], now);
export const setLatestPick = (db: D1Database, key: Key, version: string | null, now: number) =>
  setEntry(db, key, "latest_pick = ?3", [version], now);
/** An approved listing edit, shown at once; it clears any edit waiting for a maintainer. */
export const applyListing = (db: D1Database, key: Key, listing: MarketListingEdit, now: number) =>
  setEntry(db, key, "listing = ?3, pending_listing = NULL", [JSON.stringify(listing)], now);

export async function setPendingListing(
  db: D1Database,
  key: Key,
  pending: PendingListing,
): Promise<void> {
  await db
    .prepare("UPDATE entries SET pending_listing = ?3 WHERE type = ?1 AND name = ?2")
    .bind(key.type, key.name, JSON.stringify(pending))
    .run();
}

/** A version's own column, with the entry brought in step (its deprecation shows on the index). */
async function setVersion(
  db: D1Database,
  key: Key & { version: string },
  sql: string,
  value: string | null,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE versions SET ${sql} = ?4 WHERE type = ?1 AND name = ?2 AND version = ?3`)
      .bind(key.type, key.name, key.version, value),
    bumpGeneration(db, key.type, key.name),
  ]);
  await refreshEntry(db, key.type, key.name, now);
}

export const setChangelog = (
  db: D1Database,
  key: Key & { version: string },
  text: string,
  now: number,
) => setVersion(db, key, "changelog", text, now);
export const setDeprecated = (
  db: D1Database,
  key: Key & { version: string },
  note: string | null,
  now: number,
) => setVersion(db, key, "deprecated", note, now);

/**
 * Deletes an entry that never had a listed version, with its versions, offers and appeals, and
 * the bytes no other version names. Answers false when it was listed after all.
 */
export async function deleteNeverListed(
  db: D1Database,
  bucket: R2Bucket,
  key: Key,
  publisher: string,
): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT version, hash, listed FROM versions WHERE type = ?1 AND name = ?2")
    .bind(key.type, key.name)
    .all<{ version: string; hash: string; listed: number }>();
  if (results.some((row) => row.listed === 1)) return false;
  const never = "NOT EXISTS (SELECT 1 FROM versions WHERE type = ?1 AND name = ?2 AND listed = 1)";
  const outcome = await db.batch([
    db
      .prepare(`DELETE FROM pending_withdrawals WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name),
    db
      .prepare(`DELETE FROM appeals WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name),
    db
      .prepare(`DELETE FROM transfers WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name),
    db
      .prepare(`DELETE FROM removals WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name),
    db
      .prepare(`DELETE FROM versions WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name),
    db
      .prepare(
        `DELETE FROM entries WHERE type = ?1 AND name = ?2 AND first_listed IS NULL AND listed = 0
          AND NOT EXISTS (SELECT 1 FROM versions WHERE type = ?1 AND name = ?2)`,
      )
      .bind(key.type, key.name),
    unpinStatement(db, publisher, key as MarketEntryRef),
  ]);
  if ((outcome[5]?.meta.changes ?? 0) !== 1) return false;
  const hashes = [...new Set(results.map((row) => row.hash))];
  for (const hash of hashes) {
    const other = await db
      .prepare("SELECT 1 AS found FROM versions WHERE hash = ?1 LIMIT 1")
      .bind(hash)
      .first<{ found: number }>();
    if (!other) await bucket.delete(objectKey(hash));
  }
  await bucket.delete(results.map((row) => versionReportKey({ ...key, version: row.version })));
  return true;
}
