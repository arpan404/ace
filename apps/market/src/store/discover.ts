import { freshOrder, search, tierOf, tiered, type FeedEntry } from "@ace/marketplace";
import type {
  MarketDiscoverBody,
  MarketTopPublisher,
  MarketTrendMovement,
} from "@ace/protocol/marketplace";
import { featuredEntries, type SearchInput } from "../catalog.ts";
import { summary } from "../rules.ts";
import { fromCatalogues, type Databases } from "./databases.ts";
import { listedEverywhere } from "./read.ts";
import { officialPublisher } from "./lists.ts";
import { collections } from "./maintainers.ts";

/*
 * Discover's answers (ADR 0174 §6): one body from what the cron ranked and the maintainers
 * curated, and search with its sorts. Entries are index-shaped. Featured and collections are
 * editorial and never boosted; the tiers touch trending, top publishers, New and notable's ties
 * and search. Nothing here is per reader. Entries come from every catalogue, rankings from the
 * counts database, curation from the lists database (ADR 0174 §16).
 */

const key = (entry: { type: string; name: string }) => `${entry.type}/${entry.name}`;

/** Each listed entry with its tier. */
async function tieredEntries(dbs: Databases) {
  const [rows, official] = await Promise.all([
    listedEverywhere(dbs),
    officialPublisher(dbs.publishers),
  ]);
  return rows.map((row) => ({
    row,
    tier: tierOf({ official: row.publisher.id === official, verified: row.verified }),
  }));
}

/** Entries first listed after `after` and reviewed, over every catalogue. */
const freshRows = (dbs: Databases, after: number) =>
  fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        "SELECT type, name, first_listed FROM entries WHERE listed = 1 AND reviewed = 1 AND first_listed > ?1",
      )
      .bind(after)
      .all<{ type: string; name: string; first_listed: number }>();
    return results;
  });

interface TopRow {
  publisher: string;
  downloads: number;
  entries: number;
}

/**
 * Top publishers as last ranked, with their profiles: active ones with a listed, reviewed entry
 * now, in rank order.
 */
async function topShown(
  dbs: Databases,
  entries: readonly { row: { publisher: { id: string }; reviewed: boolean } }[],
) {
  const { results: ranked } = await dbs.counts
    .prepare("SELECT publisher, downloads, entries FROM top_publishers ORDER BY rank LIMIT 100")
    .all<TopRow>();
  const reviewedBy = new Set(
    entries.filter((entry) => entry.row.reviewed).map((entry) => entry.row.publisher.id),
  );
  const { results: profiles } = await dbs.publishers
    .prepare(
      `SELECT id, name, display_name, avatar, verified FROM publishers
        WHERE state = 'active' AND id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(ranked.map((row) => row.publisher)))
    .all<{
      id: string;
      name: string;
      display_name: string;
      avatar: string | null;
      verified: number;
    }>();
  const byId = new Map(profiles.map((row) => [row.id, row]));
  return ranked
    .flatMap((row) => {
      const profile = byId.get(row.publisher);
      return profile && reviewedBy.has(row.publisher) ? [{ ...profile, ...row }] : [];
    })
    .slice(0, 12);
}

export async function discoverBody(dbs: Databases, now: number): Promise<MarketDiscoverBody> {
  const [entries, featured, trending, fresh, curated, ranked] = await Promise.all([
    tieredEntries(dbs),
    featuredEntries(dbs),
    dbs.counts
      .prepare("SELECT rank, type, name, week, movement FROM trending ORDER BY rank LIMIT 200")
      .all<{ rank: number; type: string; name: string; week: number; movement: string }>(),
    freshRows(dbs, now - 30 * 86_400_000),
    collections(dbs.lists),
    dbs.counts
      .prepare("SELECT value FROM meta WHERE key = 'trending_ranked'")
      .first<{ value: number }>(),
  ]);
  const publishers = { results: await topShown(dbs, entries) };
  const byKey = new Map(entries.map((entry) => [key(entry.row), entry]));
  const shown = (item: { type: string; name: string }): FeedEntry[] => {
    const found = byKey.get(key(item));
    return found ? [summary(found.row)] : [];
  };
  const featuredShown = featured.map(summary);
  const freshShown = freshOrder(
    fresh.flatMap((row) => {
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
  dbs: Databases,
  input: SearchInput,
  sort: SearchSort,
): Promise<{ entries: FeedEntry[]; total: number }> {
  const entries = (await tieredEntries(dbs)).filter(
    (entry) => !input.publisher || entry.row.publisher.name === input.publisher,
  );
  const items = entries.map((entry) =>
    Object.assign(summary(entry.row), { source: "market", tier: entry.tier }),
  );
  let found = search(items, input);
  if (sort === "trending") {
    const { results } = await dbs.counts
      .prepare("SELECT type, name, score FROM trending")
      .all<{ type: string; name: string; score: number }>();
    const scores = new Map(results.map((row) => [key(row), row.score]));
    found = found.toSorted((a, b) => (scores.get(key(b)) ?? 0) - (scores.get(key(a)) ?? 0));
  } else if (sort === "new") {
    const results = await fromCatalogues(dbs, async ({ db }) => {
      const { results: rows } = await db
        .prepare("SELECT type, name, first_listed FROM entries WHERE listed = 1")
        .all<{ type: string; name: string; first_listed: number | null }>();
      return rows;
    });
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
