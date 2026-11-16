import { freshOrder, search, tierOf, tiered, type FeedEntry } from "@ace/marketplace";
import type {
  MarketDiscoverBody,
  MarketTopPublisher,
  MarketTrendMovement,
} from "@ace/protocol/marketplace";
import { featuredEntries, type SearchInput } from "../catalog.ts";
import { summary } from "../rules.ts";
import { listedEntries } from "./read.ts";
import { officialPublisher } from "./lists.ts";
import { collections } from "./maintainers.ts";

/*
 * Discover's answers (ADR 0173 §6): one body from what the cron ranked and the maintainers
 * curated, and search with its sorts. Entries are index-shaped. Featured and collections are
 * editorial and never boosted; the tiers touch trending, top publishers, New and notable's ties
 * and search. Nothing here is per reader.
 */

const key = (entry: { type: string; name: string }) => `${entry.type}/${entry.name}`;

/** Each listed entry with its tier. */
async function tieredEntries(db: D1Database) {
  const [rows, official] = await Promise.all([listedEntries(db), officialPublisher(db)]);
  return rows.map((row) => ({
    row,
    tier: tierOf({ official: row.publisher.id === official, verified: row.verified }),
  }));
}

export async function discoverBody(db: D1Database, now: number): Promise<MarketDiscoverBody> {
  const [entries, featured, trending, fresh, curated, publishers, ranked] = await Promise.all([
    tieredEntries(db),
    featuredEntries(db),
    db
      .prepare("SELECT rank, type, name, week, movement FROM trending ORDER BY rank LIMIT 200")
      .all<{ rank: number; type: string; name: string; week: number; movement: string }>(),
    db
      .prepare(
        "SELECT type, name, first_listed FROM entries WHERE listed = 1 AND reviewed = 1 AND first_listed > ?1",
      )
      .bind(now - 30 * 86_400_000)
      .all<{ type: string; name: string; first_listed: number }>(),
    collections(db),
    db
      .prepare(
        `SELECT t.downloads, t.entries, p.name, p.display_name, p.avatar, p.verified
          FROM top_publishers t JOIN publishers p ON p.id = t.publisher
          WHERE p.state = 'active' AND EXISTS (SELECT 1 FROM entries e
            WHERE e.publisher = p.id AND e.listed = 1 AND e.reviewed = 1)
          ORDER BY t.rank LIMIT 12`,
      )
      .all<{
        downloads: number;
        entries: number;
        name: string;
        display_name: string;
        avatar: string | null;
        verified: number;
      }>(),
    db.prepare("SELECT value FROM meta WHERE key = 'trending_ranked'").first<{ value: number }>(),
  ]);
  const byKey = new Map(entries.map((entry) => [key(entry.row), entry]));
  const shown = (item: { type: string; name: string }): FeedEntry[] => {
    const found = byKey.get(key(item));
    return found ? [summary(found.row)] : [];
  };
  const featuredShown = featured.map(summary);
  const freshShown = freshOrder(
    fresh.results.flatMap((row) => {
      const found = byKey.get(key(row));
      return found ? [{ key: key(row), firstListed: row.first_listed, tier: found.tier }] : [];
    }),
    now,
  );
  // Trending rows whose entry left the index since the ranking are skipped, ranks kept dense.
  const trendingShown = trending.results
    .flatMap((row) => {
      const entry = shown(row)[0];
      return entry
        ? [
            {
              entry,
              movement: JSON.parse(row.movement) as MarketTrendMovement,
              week: row.week,
            },
          ]
        : [];
    })
    .slice(0, 50)
    .map((row, index) => Object.assign(row, { rank: index + 1 }));
  return {
    ...(featuredShown[0] ? { hero: featuredShown[0] } : {}),
    featured: featuredShown.slice(0, 24),
    trending: trendingShown,
    fresh: freshShown.flatMap((row) => {
      const found = byKey.get(row.key);
      return found ? [summary(found.row)] : [];
    }),
    collections: curated.slice(0, 16).map((collection) => ({
      id: collection.id,
      title: collection.title,
      line: collection.line,
      entries: collection.entries.flatMap(shown),
    })),
    publishers: publishers.results.map((row) => {
      const publisher: MarketTopPublisher = {
        handle: row.name,
        displayName: row.display_name || row.name,
        verified: row.verified === 1,
        entries: row.entries,
        downloads: row.downloads,
      };
      if (row.avatar) publisher.avatar = row.avatar;
      return publisher;
    }),
    rankedAt: ranked?.value ?? 0,
  };
}

/* ---------------------------------------------------------------- search */

export type SearchSort = "relevance" | "trending" | "new" | "downloads";
export const searchSorts: readonly SearchSort[] = ["relevance", "trending", "new", "downloads"];
export const searchLimit = 50;

export function searchSort(value: string | null): SearchSort {
  return searchSorts.find((sort) => sort === value) ?? "relevance";
}

/**
 * Search over the index's entries (never unlisted or archived), the publisher's tier a bounded
 * multiplier, then sorted: relevance as the matcher ranks, trending by the last ranking's score,
 * new by first listing, downloads by total, each with the tier applied where it scores.
 */
export async function searchSorted(
  db: D1Database,
  input: SearchInput,
  sort: SearchSort,
): Promise<{ entries: FeedEntry[]; total: number }> {
  const entries = (await tieredEntries(db)).filter(
    (entry) => !input.publisher || entry.row.publisher.name === input.publisher,
  );
  const items = entries.map((entry) =>
    Object.assign(summary(entry.row), { source: "market", tier: entry.tier }),
  );
  let found = search(items, input);
  if (sort === "trending") {
    const { results } = await db
      .prepare("SELECT type, name, score FROM trending")
      .all<{ type: string; name: string; score: number }>();
    const scores = new Map(results.map((row) => [key(row), row.score]));
    found = found.toSorted((a, b) => (scores.get(key(b)) ?? 0) - (scores.get(key(a)) ?? 0));
  } else if (sort === "new") {
    const { results } = await db
      .prepare("SELECT type, name, first_listed FROM entries WHERE listed = 1")
      .all<{ type: string; name: string; first_listed: number | null }>();
    const first = new Map(results.map((row) => [key(row), row.first_listed ?? 0]));
    found = found.toSorted((a, b) => (first.get(key(b)) ?? 0) - (first.get(key(a)) ?? 0));
  } else if (sort === "downloads") {
    found = found.toSorted((a, b) => tiered(b.downloads, b.tier) - tiered(a.downloads, a.tier));
  }
  const offset = input.offset ?? 0;
  return {
    entries: found
      .slice(offset, offset + searchLimit)
      .map(({ source: _source, tier: _tier, ...entry }) => entry),
    total: found.length,
  };
}
