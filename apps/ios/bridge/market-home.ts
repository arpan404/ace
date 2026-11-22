import type { MarketResult, MarketSource } from "@ace/protocol/marketplace";
import { count, readAtText } from "@ace/ui-core/market";
import { entryRow, updatesText, type MarketWords } from "./market-rows.ts";

/*
 * Browsing the market on the phone (spec items 1 to 5): Discover's shelves, the device's own
 * listings, search, sources and a publisher's page, each answered with its words written.
 * Pure: the daemon's result in, the phone's answer out. Slice #2500 shapes these further.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

const listingsText = (readAt: number | undefined, words: MarketWords) =>
  readAt === undefined ? null : `Listings from ${readAtText(readAt, words.now)}`;

export function discoverAnswer(result: Result<"discover">) {
  const { discover } = result;
  return {
    hero: discover.hero ? entryRow(discover.hero) : null,
    featured: discover.featured.map(entryRow),
    trending: discover.trending.map((row) => ({ ...entryRow(row.entry), rank: row.rank })),
    fresh: discover.fresh.map(entryRow),
    collections: discover.collections.map((collection) => ({
      id: collection.id,
      title: collection.title,
      line: collection.line,
      rows: collection.entries.map(entryRow),
    })),
    publishers: discover.publishers.map((publisher) => ({
      handle: publisher.handle,
      name: publisher.displayName,
      avatar: publisher.avatar ?? null,
      verified: publisher.verified,
      official: publisher.official === true,
      entriesText: count(publisher.entries, "entry", "entries"),
    })),
  };
}

export function homeAnswer(result: Result<"home">) {
  return {
    featured: result.featured.map(entryRow),
    categories: result.categories.map((category) => ({
      id: category.id,
      title: category.title,
      countText: count(category.entries, "entry", "entries"),
    })),
    installed: result.installed,
    updates: result.updates,
    updatesText: updatesText(result.updates),
  };
}

export function searchAnswer(result: Result<"search">, words: MarketWords) {
  return {
    rows: result.entries.map(entryRow),
    total: result.total,
    totalText: count(result.total, "result"),
    listings: listingsText(result.readAt, words),
  };
}

function sourceRow(source: MarketSource, words: MarketWords) {
  return {
    id: source.id,
    kind: source.kind,
    title: source.kind === "market" ? "ace's marketplace" : source.address,
    address: source.address,
    enabled: source.enabled,
    entriesText: count(source.entries, "entry", "entries"),
    listings: listingsText(source.readAt, words) ?? "Not read yet",
    problem: source.problem ?? null,
  };
}

export function sourcesAnswer(result: Result<"sources">, words: MarketWords) {
  return { sources: result.sources.map((source) => sourceRow(source, words)) };
}

export function publisherAnswer(result: Result<"publisher">) {
  const { page } = result;
  return {
    handle: page.profile.handle,
    name: page.profile.displayName,
    bio: page.profile.bio,
    avatar: page.profile.avatar ?? null,
    verified: page.profile.verified,
    official: page.official === true,
    downloadsText: count(page.downloads, "download"),
    pinned: page.pinned.map(entryRow),
    rows: page.entries.map(entryRow),
  };
}

export function pictureAnswer(result: Result<"picture">) {
  return { mime: result.type, data: result.data };
}
