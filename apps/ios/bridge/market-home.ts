import type { MarketResult, MarketSource, MarketTrendMovement } from "@ace/protocol/marketplace";
import { count, readAtText, sentence } from "@ace/ui-core/market";
import { listingRow, type BrowseWords } from "./market-actions.ts";
import { updatesText, type MarketWords } from "./market-rows.ts";

/*
 * Browsing the market on the phone (spec items 1 to 5): Discover's shelves, the device's own
 * listings, search, sources and a publisher's page, each answered with its words written.
 * Pure: the daemon's result in, the phone's answer out.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

const listingsText = (readAt: number | undefined, words: MarketWords) =>
  readAt === undefined ? null : `Listings from ${readAtText(readAt, words.now)}`;

/** How a trending row's place moved this week: "New", "Up 3", "Down 1"; nothing when it held. */
function movementText(movement: MarketTrendMovement): string | null {
  switch (movement.kind) {
    case "new":
      return "New";
    case "up":
      return `Up ${movement.by}`;
    case "down":
      return `Down ${movement.by}`;
    default:
      return null;
  }
}

/**
 * Discover's shelves (spec item 27). A collection with nothing in it is left off, and `empty`
 * says every shelf is, so the home shows the device's own listings instead.
 */
export function discoverAnswer(result: Result<"discover">, words: BrowseWords) {
  const { discover } = result;
  const entryRow = listingRow(words);
  const answer = {
    hero: discover.hero ? entryRow(discover.hero) : null,
    featured: discover.featured.map(entryRow),
    trending: discover.trending.map((row) => ({
      ...entryRow(row.entry),
      rank: row.rank,
      movement: movementText(row.movement),
    })),
    fresh: discover.fresh.map(entryRow),
    collections: discover.collections
      .filter((collection) => collection.entries.length > 0)
      .map((collection) => ({
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
  const empty =
    !answer.hero &&
    [answer.featured, answer.trending, answer.fresh, answer.collections, answer.publishers].every(
      (shelf) => shelf.length === 0,
    );
  return { ...answer, empty };
}

export function homeAnswer(result: Result<"home">, words: BrowseWords) {
  const entryRow = listingRow(words);
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

export function searchAnswer(result: Result<"search">, words: BrowseWords) {
  const entryRow = listingRow(words);
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
    /** Only a git catalog the person added can be removed; ace's marketplace is turned off. */
    removable: source.kind === "git",
    entriesText: count(source.entries, "entry", "entries"),
    listings: listingsText(source.readAt, words) ?? "Not read yet",
    problem: source.problem ? sentence(source.problem) : null,
  };
}

/**
 * The sources, ace's marketplace first. With one that's on but couldn't be read, `stale` says
 * when the oldest listing in use was read (spec item 5): browsing still works from it.
 */
export function sourcesAnswer(result: Result<"sources">, words: MarketWords) {
  const sources = result.sources.toSorted(
    (a, b) => Number(b.kind === "market") - Number(a.kind === "market"),
  );
  const unread = sources
    .filter((source) => source.enabled && source.problem && source.readAt !== undefined)
    .map((source) => source.readAt ?? 0);
  return {
    sources: sources.map((source) => sourceRow(source, words)),
    stale: unread.length ? listingsText(Math.min(...unread), words) : null,
  };
}

/** A publisher's public page, read only; its pinned entries lead and aren't listed again. */
export function publisherAnswer(result: Result<"publisher">, words: BrowseWords) {
  const { page } = result;
  const entryRow = listingRow(words);
  const pinned = page.pinned.map(entryRow);
  const pinnedIds = new Set(pinned.map((row) => row.id));
  return {
    handle: page.profile.handle,
    name: page.profile.displayName,
    bio: page.profile.bio,
    avatar: page.profile.avatar ?? null,
    verified: page.profile.verified,
    official: page.official === true,
    downloadsText: count(page.downloads, "download"),
    pinned,
    rows: page.entries.map(entryRow).filter((row) => !pinnedIds.has(row.id)),
  };
}

export function pictureAnswer(result: Result<"picture">) {
  return { mime: result.type, data: result.data };
}
