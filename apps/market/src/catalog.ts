import { search, type FeedEntry } from "@ace/marketplace";
import { type MarketIndexBody as IndexBody } from "@ace/protocol/marketplace";
import { MarketCategoryId, MarketEntryType, MarketPublisherName } from "@ace/protocol/marketplace";
import { publicVersions, summary, visibleFeatured, type EntryRow } from "./rules.ts";
import { entryManagement, entryRow } from "./store/rows.ts";
import {
  currentStamp,
  featured,
  findEntryJoined,
  listedEntries,
  removedSince,
  versionsOf,
} from "./store/read.ts";

/* The catalog's answers, shared by the read routes and the web page. */

/** `?since=`: absent, a stamp, or something else. */
export function parseSince(value: string | null): number | undefined | "invalid" {
  if (value === null) return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : "invalid";
}

export async function indexBody(db: D1Database, since?: number): Promise<IndexBody> {
  // The stamp first: a change landing while the entries are read is sent again next time
  // rather than missed.
  const stamp = await currentStamp(db);
  const entries = (await listedEntries(db, since)).map(summary);
  if (since === undefined) return { stamp, full: true, entries, removed: [] };
  return { stamp, full: false, entries, removed: await removedSince(db, since) };
}

export interface SearchInput {
  query: string;
  type?: string | undefined;
  category?: string | undefined;
  /** Only this publisher's entries, by handle (ADR 0173 §6). */
  publisher?: string | undefined;
  offset?: number | undefined;
}

/**
 * Reads a search from a URL's `q`, `type`, `category`, `publisher` and `offset`, dropping values
 * that name nothing.
 */
export function searchInput(params: URLSearchParams): SearchInput {
  const offset = /^\d{1,5}$/.test(params.get("offset") ?? "") ? Number(params.get("offset")) : 0;
  return {
    query: (params.get("q") ?? "").slice(0, 200),
    type: MarketEntryType.safeParse(params.get("type")).data,
    category: MarketCategoryId.safeParse(params.get("category")).data,
    publisher: MarketPublisherName.safeParse(params.get("publisher")).data,
    ...(offset > 0 ? { offset } : {}),
  };
}

export const searchLimit = 50;

export async function searchEntries(
  db: D1Database,
  input: SearchInput,
): Promise<{ entries: FeedEntry[]; total: number }> {
  // Only the index's entries: never an unlisted or archived one.
  const entries = (await listedEntries(db))
    .filter((row) => !input.publisher || row.publisher.name === input.publisher)
    .map(summary);
  const found = search(
    entries.map((entry) => Object.assign({}, entry, { source: "market" })),
    input,
  );
  const offset = input.offset ?? 0;
  return {
    entries: found
      .slice(offset, offset + searchLimit)
      .map(({ source: _source, ...entry }) => entry),
    total: found.length,
  };
}

/** The featured entries, listed and reviewed, in the maintainers' order. */
export async function featuredEntries(db: D1Database): Promise<EntryRow[]> {
  const [list, rows] = await Promise.all([featured(db), listedEntries(db)]);
  const byKey = new Map(rows.map((row) => [`${row.type}/${row.name}`, row]));
  return visibleFeatured(list, byKey).flatMap((item) => {
    const row = byKey.get(`${item.type}/${item.name}`);
    return row ? [row] : [];
  });
}

/**
 * An entry's page, if it has a signed version: with its listing edit's links and pictures, and
 * whether it is unlisted. An unlisted entry's page still answers, so a direct link installs it.
 */
export async function entryPage(db: D1Database, type: string, name: string) {
  const [joined, versions] = await Promise.all([
    findEntryJoined(db, type, name),
    versionsOf(db, type, name),
  ]);
  const visible = publicVersions(versions);
  if (!joined || visible.length === 0) return undefined;
  const row = entryRow(joined);
  const manage = entryManagement(joined, {
    state: joined.publisher_state,
    verified: joined.publisher_verified,
  });
  return {
    row,
    entry: summary(row),
    description: row.description,
    versions: visible,
    links: manage.listing?.links ?? [],
    previews: manage.listing?.previews ?? [],
    unlisted: manage.visibility === "unlisted",
  };
}
