import { z } from "zod";
import { ContainedPath } from "./contained-path.ts";
import {
  MarketCategory,
  MarketCategoryId,
  MarketEntryName,
  MarketEntryVersion,
  MarketHash,
  MarketPublisher,
  MarketVersion,
  trimmedText,
} from "./marketplace-base.ts";
import { Signed } from "./marketplace-signed.ts";

/*
 * The catalog on the wire (ADR 0168 §3, §4, §5): the read routes' bodies, an entry's
 * `market.json`, a git catalog's `marketplace.json` and a bot recipe's `bot.json`. Reading is
 * lenient where 0168 says so: an unknown field is kept by the reader, an unusable display value
 * falls back, and only an entry without a usable type and name is left out. Schema only.
 */

/* ---------------------------------------------------------------- the index */

/** An entry type as the wire carries it: any lowercase word, so a newer type is kept. */
export const MarketWireType = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/);

// The reference documents what a well-formed file holds (`x-ace-json-input`) and says in words
// how the reader treats a value that isn't, since JSON Schema can't state a fallback.
/** A value read leniently: one that doesn't parse reads as `fallback`. */
function orElse<T extends z.ZodType>(schema: T, fallback: z.output<T>) {
  return schema.catch(fallback).meta({
    "x-ace-json-input": schema,
    "x-ace-constraint": "A value that doesn't parse is read as its default.",
  });
}
/** A list read leniently: the reader keeps the items that parse and drops the rest. */
function keptItems<T extends z.ZodType>(lenient: T, items: z.ZodType) {
  return lenient.meta({
    "x-ace-json-input": items,
    "x-ace-constraint":
      "Items that don't parse are dropped; a value that isn't a list reads as none.",
  });
}

const displayKeywords = z
  .array(z.unknown())
  .catch([])
  .transform((items) =>
    items
      .flatMap((item) =>
        typeof item === "string" && item.length > 0 && item.length <= 40 ? [item] : [],
      )
      .slice(0, 16),
  );
const keywordList = z.array(z.string().min(1).max(40)).max(16);

/** One `/v1/index` entry read leniently: display values that don't parse fall back. */
export const MarketFeedEntryWire = z.object({
  type: MarketWireType,
  name: MarketEntryName,
  title: orElse(trimmedText(1, 120).optional(), undefined),
  line: orElse(z.string().max(300), ""),
  publisher: orElse(MarketPublisher.optional(), undefined),
  categories: keptItems(
    z
      .array(z.unknown())
      .catch([])
      .transform((items) =>
        items
          .flatMap((item) => (MarketCategoryId.safeParse(item).success ? [item as string] : []))
          .slice(0, 3),
      ),
    z.array(MarketCategoryId).max(3),
  ),
  keywords: keptItems(displayKeywords, keywordList),
  version: orElse(MarketVersion.optional(), undefined),
  reviewed: orElse(z.boolean(), false),
  byAce: orElse(z.boolean(), false),
  updated: orElse(z.number().int().nonnegative(), 0),
  downloads: orElse(z.number().int().nonnegative(), 0),
  /** The publisher carries ace's verified mark (ADR 0173 §3). */
  verified: orElse(z.boolean(), false),
  /** The publisher's note on the latest version, when they deprecated it. */
  deprecated: orElse(z.string().max(500).optional(), undefined),
  /** The listing pictures by sha256 (ADR 0173 §5), served at `/v1/previews/{sha256}`. */
  previews: orElse(z.array(MarketHash).max(4).optional(), undefined),
});

/** The index fields the Worker writes, all known to this build. */
export const marketFeedFields = [
  "type",
  "name",
  "title",
  "line",
  "publisher",
  "categories",
  "keywords",
  "version",
  "reviewed",
  "byAce",
  "updated",
  "downloads",
  "verified",
  "deprecated",
  "previews",
] as const;

export const MarketIndexBody = z.object({
  stamp: z.number().int().nonnegative(),
  /** False for a `since` answer: entries changed since then, and the ones removed. */
  full: z.boolean(),
  entries: z.array(z.unknown()).max(50_000),
  removed: z
    .array(z.object({ type: z.string().max(40), name: z.string().max(64) }))
    .max(50_000)
    .default([]),
});
export type MarketIndexBody = z.infer<typeof MarketIndexBody>;

/** The items of a list that parse; the rest are dropped, as unusable display values are. */
const parsedOnly =
  <T>(schema: z.ZodType<T>) =>
  (list: readonly unknown[]): T[] =>
    list.flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });

export const CategoriesBody = z.object({
  categories: keptItems(
    z.array(z.unknown()).max(64).transform(parsedOnly(MarketCategory)),
    z.array(MarketCategory).max(64),
  ),
});
export const FeaturedBody = z.object({
  entries: z.array(z.object({ type: z.string().max(40), name: z.string().max(64) })).max(64),
});

/** A link on a listing or a profile: https only, with a short label. */
export const MarketLink = z.strictObject({
  label: trimmedText(1, 40),
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/),
});
export type MarketLink = z.infer<typeof MarketLink>;

/** `/v1/entries/{type}/{name}`. Links and pictures are ADR 0173's listing edits. */
export const EntryBody = z.object({
  entry: z.unknown(),
  description: orElse(z.string().max(8192), ""),
  versions: keptItems(
    z.array(z.unknown()).max(200).transform(parsedOnly(MarketEntryVersion)),
    z.array(MarketEntryVersion).max(200),
  ),
  links: keptItems(
    z.array(z.unknown()).max(5).transform(parsedOnly(MarketLink)).catch([]),
    z.array(MarketLink).max(5),
  ).default([]),
  previews: orElse(z.array(MarketHash).max(4), []).default([]),
  /** The entry is unlisted: found by link, never by search (ADR 0173 §5). */
  unlisted: orElse(z.boolean(), false).default(false),
});
export type EntryBody = z.infer<typeof EntryBody>;

/** `/v1/entries/{type}/{name}/{version}`: the signed manifest and, if reviewed, its mark. */
export const VersionBody = z.object({
  manifest: Signed,
  review: Signed.optional(),
});
export type VersionBody = z.infer<typeof VersionBody>;

/** `GET /v1/search` on the Worker, for the web page and clients without the index. */
export const SearchBody = z.object({
  entries: z.array(z.unknown()).max(100),
  total: z.number().int().nonnegative(),
});

/* ---------------------------------------------------------------- an entry's own files */

/** `market.json`: the listing's words beside an entry's own files. */
export const MarketListingFile = z.strictObject({
  title: trimmedText(1, 120).optional(),
  line: trimmedText(0, 300).optional(),
  description: z.string().max(8192).optional(),
  categories: z.array(MarketCategoryId).max(3).optional(),
  keywords: z.array(trimmedText(1, 40)).max(16).optional(),
});
export type MarketListingFile = z.infer<typeof MarketListingFile>;

/** A file's text field that names the entry, read leniently from suit.json, a manifest, bot.json. */
export const MarketNamedFile = z.looseObject({
  name: orElse(z.string().max(200).optional(), undefined),
  description: orElse(z.string().max(8192).optional(), undefined),
  blurb: orElse(z.string().max(300).optional(), undefined),
});

/* ---------------------------------------------------------------- git catalogs */

const CatalogSource = z.union([ContainedPath, z.literal("."), z.literal("./")]);
const catalogDisplay = {
  title: orElse(trimmedText(1, 120).optional(), undefined),
  description: orElse(z.string().max(8192).optional(), undefined),
  version: orElse(MarketVersion.optional(), undefined),
  keywords: keptItems(
    z
      .array(z.unknown())
      .optional()
      .catch(undefined)
      .transform((items) =>
        (items ?? [])
          .flatMap((item) =>
            typeof item === "string" && item.length > 0 && item.length <= 40 ? [item] : [],
          )
          .slice(0, 16),
      ),
    keywordList.optional(),
  ),
};
/** One typed entry of a git catalog's `entries` (ADR 0168 §4). */
export const MarketCatalogItem = z.object({
  type: MarketWireType,
  name: MarketEntryName,
  source: CatalogSource,
  hash: MarketHash.optional(),
  ...catalogDisplay,
});
/** One of ADR 0014's `plugins`, read as a `spade-plugin`. */
export const MarketCatalogPlugin = z.object({
  name: MarketEntryName,
  source: CatalogSource,
  hash: MarketHash.optional(),
  ...catalogDisplay,
});
export const MarketCatalogFile = z.object({
  name: orElse(z.string().max(64).optional(), undefined),
  plugins: z.array(z.unknown()).max(256).default([]),
  entries: z.array(z.unknown()).max(1024).default([]),
});

/* ---------------------------------------------------------------- bot recipes */

/** Spade's limit on a bot's standing task, in characters (`engine::TASK_CHARS`). */
export const recipeTaskChars = 4000;
export const recipeLimits = {
  routines: 32,
  skills: 32,
  plugins: 16,
  connectors: 32,
  notes: 50,
} as const;

/** A catalogue connector's id (`spade/config/connectors.json`). */
export const RecipeConnectorId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
/** A skill from the same source (`spade-skill/<name>`) or a folder in the recipe (`skills/<name>`). */
export const RecipeSkillRef = z
  .string()
  .regex(/^(?:spade-skill|skills)\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
export const RecipePluginRef = z.string().regex(/^spade-plugin\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const HttpsUrl = z
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "A server is named by its https address")
  .meta({
    "x-ace-json-input": z.url().max(2048),
    "x-ace-constraint": "The URL's scheme must be https.",
  });
const why = trimmedText(1, 500);
const ConnectorNeed = z.union([
  z.strictObject({ id: RecipeConnectorId, why, required: z.boolean().default(false) }),
  z.strictObject({ url: HttpsUrl, why, required: z.boolean().default(false) }),
]);
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const RecipeRoutine = z.strictObject({
  name: trimmedText(1, 120),
  instruction: trimmedText(1, 4000),
  /** A phrase or cron expression Spade's routines read (`weekdays at 8:00`). */
  schedule: trimmedText(1, 200),
});

/** A bot recipe: ADR 0132's bot file at version 2, which asks rather than grants (0168 §5). */
export const Recipe = z.object({
  format: z.literal("spade-bot"),
  version: z.literal(2),
  name: trimmedText(1, 80),
  blurb: z.string().max(300).default(""),
  task: z.string().max(recipeTaskChars).default(""),
  /** The eight stored fields of Spade's face; Spade repairs an unknown value by its rules. */
  face: z.record(z.string().max(40), z.unknown()).optional(),
  model: z.enum(["fast", "capable"]).default("capable"),
  routines: z.array(RecipeRoutine).max(recipeLimits.routines).default([]),
  skills: z.array(z.string().max(80)).max(recipeLimits.skills).default([]),
  plugins: z.array(z.string().max(80)).max(recipeLimits.plugins).default([]),
  needs: z
    .strictObject({
      connectors: z.array(ConnectorNeed).max(recipeLimits.connectors).default([]),
      /** Narrows the bot's built-in tools (ADR 0161: unset means all); it never adds one. */
      tools: z.array(ToolName).max(64).optional(),
    })
    .default({ connectors: [] }),
  notes: z.array(z.string().max(2000)).max(recipeLimits.notes).default([]),
});
export type Recipe = z.infer<typeof Recipe> & { extra?: Record<string, unknown> };

/** Version 1 (ADR 0132), as an export between a person's own machines wrote it. */
export const BotFileV1 = z.object({
  format: z.literal("spade-bot"),
  version: z.literal(1),
  name: trimmedText(1, 80),
  task: z.string().max(recipeTaskChars).default(""),
  avatar: z.unknown().optional(),
  model: z.string().max(200).nullish(),
  routines: z
    .array(
      z.object({
        name: z.string().max(120),
        instruction: z.string().max(4000),
        trigger: z.unknown(),
      }),
    )
    .max(64)
    .default([]),
  connectors: z
    .object({ all: z.boolean(), connectors: z.array(z.string().max(64)).max(64).default([]) })
    .nullish(),
  notes: z.array(z.string().max(2000)).max(200).default([]),
});
export type BotFileV1 = z.infer<typeof BotFileV1>;
