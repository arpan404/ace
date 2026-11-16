import { z } from "zod";
import { PluginHash, PluginName } from "./plugins.ts";

/*
 * The marketplace's primitives (ADR 0168, 0173): entry types, names, versions, hashes,
 * publishers and categories, shared by every marketplace contract. Schema only.
 */

/** The entry types this build knows. Others are kept as their raw string and never installed. */
export const MarketEntryType = z.enum([
  "suit",
  "spade-skill",
  "spade-plugin",
  "spade-bot",
  "ace-plugin",
]);
export type MarketEntryType = z.infer<typeof MarketEntryType>;
/** The types this build installs; `ace-plugin` waits for its own ADR (phase 3). */
export const installableMarketTypes: readonly MarketEntryType[] = [
  "suit",
  "spade-skill",
  "spade-plugin",
  "spade-bot",
];

/** An entry's name within its type: the same rule as a plugin name. */
export const MarketEntryName = PluginName;
/** A published version: dotted numbers with an optional pre-release tag. */
export const MarketVersion = z
  .string()
  .max(64)
  .regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/);
export type MarketVersion = z.infer<typeof MarketVersion>;
/** ADR 0014's content hash: sha256 over sorted paths, sizes, executable bits and file hashes. */
export const MarketHash = PluginHash;
/** `market` is market.acehq.dev; a git catalog is `git:` and a short id the daemon gave it. */
export const MarketSourceId = z.string().regex(/^(?:market|git:[a-z0-9]{1,32})$/);
export type MarketSourceId = z.infer<typeof MarketSourceId>;
export const MarketCategoryId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
export const MarketPublisherName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
  .refine((value) => !value.includes("--"))
  .meta({ "x-ace-constraint": "Publisher names cannot contain consecutive hyphens." });
export const MarketPublisher = z.strictObject({
  id: z.string().min(1).max(64),
  name: MarketPublisherName,
});
export type MarketPublisher = z.infer<typeof MarketPublisher>;

export const MarketCategory = z.strictObject({
  id: MarketCategoryId,
  title: z.string().min(1).max(60),
});
export type MarketCategory = z.infer<typeof MarketCategory>;

export const MarketEntryVersion = z.strictObject({
  version: MarketVersion,
  hash: MarketHash,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  withdrawn: z.string().max(500).optional(),
  /** Its publisher's note when they deprecated it (ADR 0173 §5); installs show it. */
  deprecated: z.string().max(500).optional(),
  /** What changed in this version, in its publisher's words. */
  changelog: z.string().max(4000).optional(),
});
export type MarketEntryVersion = z.infer<typeof MarketEntryVersion>;

export const MarketProblem = z.strictObject({
  path: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().max(500),
});
export type MarketProblem = z.infer<typeof MarketProblem>;

/** One entry as a list row shows it. `type` is any string; `supported` says this build knows it. */
export const MarketEntrySummary = z.strictObject({
  source: MarketSourceId,
  type: z.string().min(1).max(40),
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  line: z.string().max(300),
  publisher: MarketPublisher.optional(),
  categories: z.array(MarketCategoryId).max(3),
  keywords: z.array(z.string().min(1).max(40)).max(16),
  version: MarketVersion.optional(),
  /** ace's maintainers read it, by the signer's word (a signed review mark). */
  reviewed: z.boolean(),
  /** Published by ace itself. */
  byAce: z.boolean(),
  updated: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  supported: z.boolean(),
  /** A git catalog's address, shown as "From <address>". */
  from: z.string().max(2048).optional(),
  /** The publisher carries ace's verified mark (ADR 0173 §3). */
  verified: z.boolean().optional(),
  /** The latest version is deprecated, with its publisher's note. */
  deprecated: z.string().max(500).optional(),
});
export type MarketEntrySummary = z.infer<typeof MarketEntrySummary>;
