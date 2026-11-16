import { search, type FeedEntry, type IndexBody } from "@ace/marketplace";
import { MarketCategoryId, MarketEntryType } from "@ace/protocol/marketplace";
import { publicVersions, summary, visibleFeatured, type EntryRow } from "./rules.ts";
import {
  currentStamp,
  featured,
  findEntry,
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
}

/** Reads a search from a URL's `q`, `type` and `category`, dropping values that name nothing. */
export function searchInput(params: URLSearchParams): SearchInput {
  return {
    query: (params.get("q") ?? "").slice(0, 200),
    type: MarketEntryType.safeParse(params.get("type")).data,
    category: MarketCategoryId.safeParse(params.get("category")).data,
  };
}

export const searchLimit = 50;

export async function searchEntries(
  db: D1Database,
  input: SearchInput,
): Promise<{ entries: FeedEntry[]; total: number }> {
  const entries = (await listedEntries(db)).map(summary);
  const found = search(
    entries.map((entry) => Object.assign({}, entry, { source: "market" })),
    input,
  );
  return {
    entries: found.slice(0, searchLimit).map(({ source: _source, ...entry }) => entry),
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

/** An entry's page, if it has a signed version. */
export async function entryPage(db: D1Database, type: string, name: string) {
  const [row, versions] = await Promise.all([
    findEntry(db, type, name),
    versionsOf(db, type, name),
  ]);
  const visible = publicVersions(versions);
  if (!row || visible.length === 0) return undefined;
  return { row, entry: summary(row), description: row.description, versions: visible };
}
