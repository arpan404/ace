import type {
  MarketAppeal,
  MarketEntryRef,
  MarketListingEdit,
  MarketOwnEntry,
  MarketOwnEntrySummary,
  MarketOwnVersion,
} from "@ace/protocol/marketplace";
import { versionReportKey } from "../context.ts";
import { currentListing, newestFirst, versionStatus, type StoredVersion } from "../rules.ts";
import { fromCatalogues, type Databases } from "./databases.ts";
import { liveTotals } from "./downloads.ts";
import { refreshEntry } from "./entries.ts";
import { markUsageDirty } from "./me-limits.ts";
import { unpinStatement } from "./profiles.ts";
import { getReport } from "./me-scan.ts";
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
 * change. An entry's settings live in its type's catalogue; every change moves its generation in
 * the same batch and brings its row in step, so the index and `since` readers follow. Reports
 * and appeals are read from the moderation database.
 */

type Key = { type: string; name: string };
type Joined = EntryTable & { publisher_state: string; publisher_verified: number };

export async function ownEntryRow(db: D1Database, key: Key): Promise<Joined | undefined> {
  return (
    (await db
      .prepare(
        `SELECT e.*, p.state AS publisher_state, p.verified AS publisher_verified
          FROM entries e JOIN publisher_copies p ON p.id = e.publisher
          WHERE e.type = ?1 AND e.name = ?2`,
      )
      .bind(key.type, key.name)
      .first<Joined>()) ?? undefined
  );
}

const manageOf = (row: Joined) =>
  entryManagement(row, { state: row.publisher_state, verified: row.publisher_verified });

const ref = (key: Key) => `${key.type}/${key.name}`;

/** Open reports on each of these entries, from the moderation database. */
async function openReports(
  moderation: D1Database,
  entries: readonly Key[],
): Promise<Map<string, number>> {
  if (entries.length === 0) return new Map();
  const { results } = await moderation
    .prepare(
      `SELECT type, name, COUNT(*) AS open FROM reports
        WHERE state = 'open' AND (type || '/' || name) IN (SELECT value FROM json_each(?1))
        GROUP BY type, name`,
    )
    .bind(JSON.stringify(entries.map(ref)))
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

/** A version with its download total now, from the counts database. */
const withLive = (version: StoredVersion, live: ReadonlyMap<string, number>, key: Key) =>
  Object.assign({}, version, {
    downloads: live.get(`${ref(key)}@${version.version}`) ?? version.downloads,
  });

/** Every entry of the publisher, over every catalogue, as the rows on their page. */
export async function ownEntrySummaries(
  dbs: Databases,
  publisher: string,
  pins: readonly MarketEntryRef[],
): Promise<MarketOwnEntrySummary[]> {
  const perCatalogue = await fromCatalogues(dbs, async ({ db }) => {
    const [entries, versions] = await Promise.all([
      db
        .prepare(
          `SELECT e.*, p.state AS publisher_state, p.verified AS publisher_verified
            FROM entries e JOIN publisher_copies p ON p.id = e.publisher
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
    ]);
    return [{ entries: entries.results, versions: versions.results }];
  });
  const entries = perCatalogue.flatMap((part) => part.entries).slice(0, 500);
  const live = await liveTotals(dbs.counts, entries);
  const byEntry = new Map<string, StoredVersion[]>();
  for (const row of perCatalogue.flatMap((part) => part.versions)) {
    const list = byEntry.get(ref(row)) ?? [];
    list.push(withLive(storedVersion(row), live, row));
    byEntry.set(ref(row), list);
  }
  const reports = await openReports(dbs.moderation, entries);
  const pinned = new Set(pins.map(ref));
  return entries.map((row) =>
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

/** Everything about one of the publisher's entries: `db` is its type's catalogue. */
export async function ownEntry(
  db: D1Database,
  dbs: Pick<Databases, "counts" | "moderation">,
  bucket: R2Bucket,
  row: Joined,
  pins: readonly MarketEntryRef[],
): Promise<MarketOwnEntry> {
  const [versionRows, appeals, reports] = await Promise.all([
    db
      .prepare("SELECT * FROM versions WHERE type = ?1 AND name = ?2")
      .bind(row.type, row.name)
      .all<VersionTable>(),
    dbs.moderation
      .prepare("SELECT * FROM appeals WHERE type = ?1 AND name = ?2 ORDER BY at")
      .bind(row.type, row.name)
      .all<AppealTable>(),
    openReports(dbs.moderation, [row]),
  ]);
  const live = await liveTotals(dbs.counts, [row]);
  const versions = versionRows.results.map((version) =>
    withLive(storedVersion(version), live, row),
  );
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

/** An entry as the authenticated publisher names it: every write re-checks it is theirs. */
export type Owned = Key & { publisher: string };

/**
 * Changes an entry's own columns and moves its generation in one statement that re-checks the
 * owner, then brings its row in step. False when the entry is no longer the publisher's: a
 * transfer accepted while this request was on its way.
 */
async function setEntry(
  db: D1Database,
  key: Owned,
  sql: string,
  values: readonly (string | number | null)[],
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE entries SET ${sql}, generation = generation + 1
        WHERE type = ?1 AND name = ?2 AND publisher = ?3`,
    )
    .bind(key.type, key.name, key.publisher, ...values)
    .run();
  if (result.meta.changes !== 1) return false;
  await refreshEntry(db, key.type, key.name, now);
  return true;
}

export const setVisibility = (db: D1Database, key: Owned, visibility: string, now: number) =>
  setEntry(db, key, "visibility = ?4", [visibility], now);
export const setArchived = (db: D1Database, key: Owned, archived: boolean, now: number) =>
  setEntry(db, key, "archived = ?4", [archived ? 1 : 0], now);
export const setLatestPick = (db: D1Database, key: Owned, version: string | null, now: number) =>
  setEntry(db, key, "latest_pick = ?4", [version], now);
/** An approved listing edit, shown at once; it clears any edit waiting for a maintainer. */
export const applyListing = (db: D1Database, key: Owned, listing: MarketListingEdit, now: number) =>
  setEntry(db, key, "listing = ?4, pending_listing = NULL", [JSON.stringify(listing)], now);

export async function setPendingListing(
  db: D1Database,
  key: Owned,
  pending: PendingListing,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE entries SET pending_listing = ?4 WHERE type = ?1 AND name = ?2 AND publisher = ?3",
    )
    .bind(key.type, key.name, key.publisher, JSON.stringify(pending))
    .run();
  return result.meta.changes === 1;
}

/**
 * A version's own column, with the entry brought in step (its deprecation shows on the index),
 * only while the entry is still the publisher's.
 */
async function setVersion(
  db: D1Database,
  key: Owned & { version: string },
  sql: string,
  value: string | null,
  now: number,
): Promise<boolean> {
  const [changed] = await db.batch([
    db
      .prepare(
        `UPDATE versions SET ${sql} = ?5 WHERE type = ?1 AND name = ?2 AND version = ?3
          AND EXISTS (SELECT 1 FROM entries WHERE type = ?1 AND name = ?2 AND publisher = ?4)`,
      )
      .bind(key.type, key.name, key.version, key.publisher, value),
    db
      .prepare(
        `UPDATE entries SET generation = generation + 1
          WHERE type = ?1 AND name = ?2 AND publisher = ?3`,
      )
      .bind(key.type, key.name, key.publisher),
  ]);
  if ((changed?.meta.changes ?? 0) !== 1) return false;
  await refreshEntry(db, key.type, key.name, now);
  return true;
}

export const setChangelog = (
  db: D1Database,
  key: Owned & { version: string },
  text: string,
  now: number,
) => setVersion(db, key, "changelog", text, now);
export const setDeprecated = (
  db: D1Database,
  key: Owned & { version: string },
  note: string | null,
  now: number,
) => setVersion(db, key, "deprecated", note, now);

/**
 * Deletes an entry of the publisher's that never had a listed version, with its versions, offers
 * and pending withdrawals, in one catalogue batch where every statement re-checks the owner and
 * that nothing was listed. Then its appeals go from moderation, its pin from the publisher, and
 * the publisher's charges are marked for the reconcile. Submitted bytes at `objects/<hash>` stay,
 * as published bytes do: another publication may name the same hash.
 */
export async function deleteNeverListed(
  dbs: Databases,
  db: D1Database,
  bucket: R2Bucket,
  key: Owned,
  now: number,
): Promise<"deleted" | "listed" | "not-yours"> {
  const { results } = await db
    .prepare("SELECT version FROM versions WHERE type = ?1 AND name = ?2")
    .bind(key.type, key.name)
    .all<{ version: string }>();
  const never = `EXISTS (SELECT 1 FROM entries WHERE type = ?1 AND name = ?2 AND publisher = ?3)
    AND NOT EXISTS (SELECT 1 FROM versions WHERE type = ?1 AND name = ?2 AND listed = 1)`;
  const scoped = (table: string) =>
    db
      .prepare(`DELETE FROM ${table} WHERE type = ?1 AND name = ?2 AND ${never}`)
      .bind(key.type, key.name, key.publisher);
  const outcome = await db.batch([
    scoped("pending_withdrawals"),
    scoped("transfers"),
    scoped("removals"),
    scoped("versions"),
    db
      .prepare(
        `DELETE FROM entries WHERE type = ?1 AND name = ?2 AND publisher = ?3
          AND first_listed IS NULL AND listed = 0
          AND NOT EXISTS (SELECT 1 FROM versions WHERE type = ?1 AND name = ?2)`,
      )
      .bind(key.type, key.name, key.publisher),
  ]);
  if ((outcome[4]?.meta.changes ?? 0) !== 1) {
    const owner = await db
      .prepare("SELECT publisher FROM entries WHERE type = ?1 AND name = ?2")
      .bind(key.type, key.name)
      .first<{ publisher: string }>();
    return owner && owner.publisher !== key.publisher ? "not-yours" : "listed";
  }
  await dbs.moderation
    .prepare("DELETE FROM appeals WHERE type = ?1 AND name = ?2")
    .bind(key.type, key.name)
    .run();
  await dbs.publishers.batch([
    unpinStatement(dbs.publishers, key.publisher, key),
    markUsageDirty(dbs.publishers, key.publisher, now),
  ]);
  if (results.length > 0)
    await bucket.delete(results.map((row) => versionReportKey({ ...key, version: row.version })));
  return "deleted";
}
