import { search, type FeedEntry } from "@ace/marketplace";
import { type MarketIndexBody as IndexBody } from "@ace/protocol/marketplace";
import { MarketCategoryId, MarketEntryType, MarketPublisherName } from "@ace/protocol/marketplace";
import { publicVersions, summary, visibleFeatured, type EntryRow } from "./rules.ts";
import { eachCatalogue, type Databases } from "./store/databases.ts";
import { liveTotals } from "./store/downloads.ts";
import { entryManagement, entryRow } from "./store/rows.ts";
import {
  currentStamp,
  featured,
  raiseStamp,
  findEntryJoined,
  listedEntries,
  listedEverywhere,
  removedSince,
  versionsOf,
} from "./store/read.ts";

/* The catalog's answers, shared by the read routes and the web page. */

/** `?since=`: absent, a stamp, or something else. */
export function parseSince(value: string | null): number | undefined | "invalid" {
  if (value === null) return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : "invalid";
}

/**
 * The index, whole or since a stamp, over every catalogue (ADR 0174 §16). Each catalogue keeps
 * its own stamp, read before its rows, so a change landing while they are read has a stamp above
 * it and is sent next time rather than missed. A catalogue whose stamp is behind the highest is
 * raised to it first, in one statement, so every catalogue's next change is above the answer's
 * stamp: the answer carries the highest stamp, and nothing is missed or sent twice.
 */
export async function indexBody(dbs: Databases, since?: number): Promise<IndexBody> {
  const read = await eachCatalogue(dbs, ({ db }) => currentStamp(db));
  const top = Math.max(...read);
  const parts = await eachCatalogue(dbs, async ({ db }, index) => {
    const own = read[index] ?? 0;
    const stamp = own < top ? await raiseStamp(db, top) : own;
    const [entries, removed] = await Promise.all([
      listedEntries(db, since),
      since === undefined ? Promise.resolve([]) : removedSince(db, since),
    ]);
    return { stamp, entries, removed };
  });
  const stamp = Math.min(...parts.map((part) => part.stamp));
  const entries = parts.flatMap((part) => part.entries).map(summary);
  if (since === undefined) return { stamp, full: true, entries, removed: [] };
  return { stamp, full: false, entries, removed: parts.flatMap((part) => part.removed) };
}

export interface SearchInput {
  query: string;
  type?: string | undefined;
  category?: string | undefined;
  /** Only this publisher's entries, by handle (ADR 0174 §6). */
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
  dbs: Databases,
  input: SearchInput,
): Promise<{ entries: FeedEntry[]; total: number }> {
  // Only the index's entries: never an unlisted or archived one.
  const entries = (await listedEverywhere(dbs))
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
export async function featuredEntries(dbs: Databases): Promise<EntryRow[]> {
  const [list, rows] = await Promise.all([featured(dbs.lists), listedEverywhere(dbs)]);
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
export async function entryPage(dbs: Databases, type: string, name: string) {
  const db = dbs.catalogue(type);
  if (!db) return undefined;
  const [joined, versions] = await Promise.all([
    findEntryJoined(db, type, name),
    versionsOf(db, type, name),
  ]);
  const live = await liveTotals(dbs.counts, [{ type, name }]);
  const visible = publicVersions(
    versions.map((version) =>
      Object.assign({}, version, {
        downloads: live.get(`${type}/${name}@${version.version}`) ?? version.downloads,
      }),
    ),
  );
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
