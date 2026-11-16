import type { Listing } from "@ace/marketplace";
import type { EntryRow, EntryState, StoredVersion } from "../rules.ts";

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
}

export interface EntryJoined extends EntryTable {
  publisher_id: string;
  publisher_name: string;
  downloads: number;
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
  };
}

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
  };
}

/** A signed statement this Worker verified before storing it. */
export const signedOf = (text: string) => JSON.parse(text) as { body: unknown; signature: string };
