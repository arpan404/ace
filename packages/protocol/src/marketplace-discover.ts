import { z } from "zod";
import {
  MarketCategoryId,
  MarketHash,
  MarketPublisherName,
  trimmedText,
} from "./marketplace-base.ts";
import { MarketDisplayName } from "./marketplace-publisher.ts";

/*
 * Discover on the wire (ADR 0174 §6): the hero, featured, Trending this week, New and notable,
 * collections and top publishers, in one body from `GET /v1/discover`. Entries are index entries,
 * read as the index is. Schema only; the ranking is `@ace/marketplace`'s `rankTrending`.
 */

/** How an entry's trending rank moved against the same ranking a week earlier. */
export const MarketTrendMovement = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new") }),
  z.strictObject({ kind: z.literal("up"), by: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("down"), by: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("same") }),
]);
export type MarketTrendMovement = z.infer<typeof MarketTrendMovement>;

export const MarketTrendingRow = z.object({
  entry: z.unknown(),
  rank: z.number().int().positive(),
  movement: MarketTrendMovement,
  /** Downloads counted this week, after the caps. */
  week: z.number().int().nonnegative(),
});

export const MarketCollectionId = MarketCategoryId;
/** A maintainers' collection as the signer uploads it. */
export const MarketCollection = z.strictObject({
  id: MarketCollectionId,
  title: trimmedText(1, 60),
  line: z.string().max(200),
  entries: z
    .array(
      z.strictObject({
        type: z.string().min(1).max(40),
        name: z.string().min(1).max(64),
      }),
    )
    .max(24),
});
export type MarketCollection = z.infer<typeof MarketCollection>;

export const MarketTopPublisher = z.strictObject({
  handle: MarketPublisherName,
  displayName: MarketDisplayName,
  avatar: MarketHash.optional(),
  verified: z.boolean(),
  entries: z.number().int().nonnegative(),
  /** Downloads over 30 days, after the caps. */
  downloads: z.number().int().nonnegative(),
});
export type MarketTopPublisher = z.infer<typeof MarketTopPublisher>;

/** `GET /v1/discover`. */
export const MarketDiscoverBody = z.object({
  hero: z.unknown().optional(),
  featured: z.array(z.unknown()).max(24),
  trending: z.array(MarketTrendingRow).max(50),
  fresh: z.array(z.unknown()).max(24),
  collections: z
    .array(
      z.object({
        id: MarketCollectionId,
        title: z.string().max(60),
        line: z.string().max(200),
        entries: z.array(z.unknown()).max(24),
      }),
    )
    .max(16),
  publishers: z.array(MarketTopPublisher).max(12),
  /** When trending was last ranked. */
  rankedAt: z.number().int().nonnegative(),
});
export type MarketDiscoverBody = z.infer<typeof MarketDiscoverBody>;
