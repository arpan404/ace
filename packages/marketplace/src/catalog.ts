import { z } from "zod";
import { ContainedPath } from "@ace/protocol";
import { MarketEntryName, MarketHash, MarketVersion } from "@ace/protocol/marketplace";
import { entryKey, FeedError, type FeedEntry } from "./feed.ts";

/*
 * A person-added git catalog (ADR 0168 §4): ADR 0014's `marketplace.json`, which may now list
 * typed `entries` beside its `plugins`. A catalog with only `plugins` reads as before, each a
 * `spade-plugin`. Git catalogs carry no signatures, review marks, categories or featured list.
 */

const Source = z.union([ContainedPath, z.literal("."), z.literal("./")]);
const display = {
  title: z.string().trim().min(1).max(120).optional().catch(undefined),
  description: z.string().max(8192).optional().catch(undefined),
  version: MarketVersion.optional().catch(undefined),
  keywords: z
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
};
const CatalogItem = z.object({
  type: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: MarketEntryName,
  source: Source,
  hash: MarketHash.optional(),
  ...display,
});
const CatalogPlugin = z.object({
  name: MarketEntryName,
  source: Source,
  hash: MarketHash.optional(),
  ...display,
});
const CatalogFile = z.object({
  name: z.string().max(64).optional().catch(undefined),
  plugins: z.array(z.unknown()).max(256).default([]),
  entries: z.array(z.unknown()).max(1024).default([]),
});

export interface CatalogEntry {
  type: string;
  name: string;
  /** The entry's folder in the repository, `.` for its root. */
  source: string;
  hash?: string | undefined;
  title: string;
  description: string;
  version?: string | undefined;
  keywords: string[];
}

export interface ParsedCatalog {
  name: string | undefined;
  entries: CatalogEntry[];
  problems: string[];
}

const folder = (source: string) =>
  source === "./" ? "." : source.startsWith("./") ? source.slice(2) : source;

/** The catalog's entries; an entry without a usable type, name and folder is left out with a note. */
export function parseCatalog(input: unknown): ParsedCatalog {
  const file = CatalogFile.safeParse(input);
  if (!file.success) throw new FeedError("marketplace.json isn't a catalog this build reads");
  const entries: CatalogEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (entry: CatalogEntry) => {
    const key = entryKey(entry);
    if (seen.has(key)) throw new FeedError(`The catalog lists ${key} twice`);
    seen.add(key);
    entries.push(entry);
  };
  for (const raw of file.data.plugins) {
    const plugin = CatalogPlugin.safeParse(raw);
    if (!plugin.success) {
      problems.push("A plugin without a usable name and folder was left out");
      continue;
    }
    const { title, description, ...rest } = plugin.data;
    add({
      ...rest,
      type: "spade-plugin",
      source: folder(rest.source),
      title: title ?? rest.name,
      description: description ?? "",
    });
  }
  for (const raw of file.data.entries) {
    const item = CatalogItem.safeParse(raw);
    if (!item.success) {
      problems.push("An entry without a usable type, name and folder was left out");
      continue;
    }
    const { title, description, ...rest } = item.data;
    add({
      ...rest,
      source: folder(rest.source),
      title: title ?? rest.name,
      description: description ?? "",
    });
  }
  return { name: file.data.name, entries, problems };
}

/** A catalog entry as a list row: never reviewed, never by ace, "From <address>". */
export function catalogFeedEntry(entry: CatalogEntry, readAt: number): FeedEntry {
  return {
    type: entry.type,
    name: entry.name,
    title: entry.title,
    line:
      entry.description
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim()
        .slice(0, 300) ?? "",
    categories: [],
    keywords: entry.keywords,
    version: entry.version,
    reviewed: false,
    byAce: false,
    updated: readAt,
    downloads: 0,
  };
}
