import type { Listing } from "@ace/marketplace";
import type { MarketListingEdit, MarketScanReport } from "@ace/protocol/marketplace";
import type {
  EntryManagement,
  EntryRow,
  EntryState,
  StoredVersion,
  VersionState,
} from "../rules.ts";

/*
 * Rows this Worker wrote, read back without validating again (ADR 0125): the casts from D1's
 * untyped rows live here and nowhere else.
 */

export interface EntryTable {
  type: string;
  name: string;
  publisher: string;
  title: string;
  line: string;
  description: string;
  categories: string;
  keywords: string;
  latest: string | null;
  reviewed: number;
  by_ace: number;
  updated: number;
  listed: number;
  visibility: string;
  archived: number;
  latest_pick: string | null;
  listing: string | null;
  pending_listing: string | null;
  first_listed: number | null;
  verified: number;
  deprecated: string | null;
}

export interface EntryJoined extends EntryTable {
  publisher_id: string;
  publisher_name: string;
  publisher_state: string;
  publisher_verified: number;
  downloads: number;
}

/** A listing edit waiting for a maintainer, as stored in `entries.pending_listing`. */
export interface PendingListing {
  listing: MarketListingEdit;
  scan: MarketScanReport;
  at: number;
}

export interface VersionTable {
  type: string;
  name: string;
  version: string;
  hash: string;
  size: number;
  published: number;
  listing: string;
  listed: number;
  manifest: string | null;
  review: string | null;
  reviewed: number;
  by_ace: number;
  withdrawn: string | null;
  downloads: number;
  state: string;
  verdict: string | null;
  block_reason: string | null;
  approved: number;
  changelog: string;
  deprecated: string | null;
  scanned: number | null;
}

const list = (text: string) => JSON.parse(text) as string[];

export function entryState(row: EntryTable): EntryState {
  return {
    listed: row.listed === 1,
    latest: row.latest ?? undefined,
    title: row.title,
    line: row.line,
    description: row.description,
    categories: list(row.categories),
    keywords: list(row.keywords),
    reviewed: row.reviewed === 1,
    byAce: row.by_ace === 1,
    verified: row.verified === 1,
    deprecated: row.deprecated ?? undefined,
  };
}

/** What the publisher set on the entry, with its publisher's standing. */
export function entryManagement(
  row: EntryTable,
  publisher: { state: string; verified: number },
): EntryManagement {
  return {
    visibility: row.visibility === "unlisted" ? "unlisted" : "listed",
    archived: row.archived === 1,
    latestPick: row.latest_pick ?? undefined,
    listing: row.listing ? (JSON.parse(row.listing) as MarketListingEdit) : undefined,
    publisherActive: publisher.state === "active",
    publisherVerified: publisher.verified === 1,
  };
}

export const pendingListingOf = (row: EntryTable): PendingListing | undefined =>
  row.pending_listing ? (JSON.parse(row.pending_listing) as PendingListing) : undefined;

export function entryRow(row: EntryJoined): EntryRow {
  return {
    ...entryState(row),
    type: row.type,
    name: row.name,
    publisher: { id: row.publisher_id, name: row.publisher_name },
    updated: row.updated,
    downloads: row.downloads,
  };
}

export function storedVersion(row: VersionTable): StoredVersion {
  return {
    version: row.version,
    hash: row.hash,
    size: row.size,
    published: row.published,
    listing: JSON.parse(row.listing) as Listing,
    listed: row.listed === 1,
    withdrawn: row.withdrawn ?? undefined,
    reviewed: row.reviewed === 1,
    byAce: row.by_ace === 1,
    downloads: row.downloads,
    state: row.state as VersionState,
    blockReason: row.block_reason ?? undefined,
    deprecated: row.deprecated ?? undefined,
    changelog: row.changelog,
  };
}

/** A signed statement this Worker verified before storing it. */
export const signedOf = (text: string) => JSON.parse(text) as { body: unknown; signature: string };
