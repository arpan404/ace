import {
  MarketCatalogFile,
  MarketCatalogItem,
  MarketCatalogPlugin,
} from "@ace/protocol/marketplace";
import { entryKey, FeedError, type FeedEntry } from "./feed.ts";

/*
 * A person-added git catalog (ADR 0168 §4): ADR 0014's `marketplace.json`, which may now list
 * typed `entries` beside its `plugins`. A catalog with only `plugins` reads as before, each a
 * `spade-plugin`. Git catalogs carry no signatures, review marks, categories or featured list.
 */

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
  const file = MarketCatalogFile.safeParse(input);
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
    const plugin = MarketCatalogPlugin.safeParse(raw);
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
    const item = MarketCatalogItem.safeParse(raw);
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
