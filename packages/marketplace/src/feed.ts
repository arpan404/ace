import { z } from "zod";
import {
  MarketCategory,
  MarketCategoryId,
  MarketEntryName,
  MarketEntryType,
  MarketEntryVersion,
  MarketPublisher,
  MarketVersion,
} from "@ace/protocol/marketplace";
import { Signed } from "./signing.ts";

/*
 * The catalog API's bodies (ADR 0168 §3), shared by the Worker that writes them and the daemon
 * that reads them. Reading is lenient: an unknown type or field is kept, an unusable display
 * value is dropped (the entry falls back to its name), and only an entry without a usable type
 * and name is left out, with a note. Two entries with one type and name refuse the whole body.
 */

/** One entry in `/v1/index`: what a list row needs, nothing more. */
export interface FeedEntry {
  type: string;
  name: string;
  title: string;
  line: string;
  publisher?: MarketPublisher | undefined;
  categories: string[];
  keywords: string[];
  version?: string | undefined;
  reviewed: boolean;
  byAce: boolean;
  updated: number;
  downloads: number;
  /** Fields this build doesn't know, kept as they came. */
  extra?: Record<string, unknown> | undefined;
}

const known = new Set([
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
]);

const lenient = {
  title: z.string().trim().min(1).max(120).optional().catch(undefined),
  line: z.string().max(300).catch(""),
  publisher: MarketPublisher.optional().catch(undefined),
  categories: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items
        .flatMap((item) => (MarketCategoryId.safeParse(item).success ? [item as string] : []))
        .slice(0, 3),
    ),
  keywords: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items
        .flatMap((item) =>
          typeof item === "string" && item.length > 0 && item.length <= 40 ? [item] : [],
        )
        .slice(0, 16),
    ),
  version: MarketVersion.optional().catch(undefined),
  reviewed: z.boolean().catch(false),
  byAce: z.boolean().catch(false),
  updated: z.number().int().nonnegative().catch(0),
  downloads: z.number().int().nonnegative().catch(0),
};
const EntryShape = z.object({
  type: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: MarketEntryName,
  ...lenient,
});

export const entryKey = (entry: { type: string; name: string }) => `${entry.type}/${entry.name}`;

/** One entry from the wire, or a note saying why it was left out. */
export function readFeedEntry(input: unknown): FeedEntry | { problem: string } {
  const parsed = EntryShape.safeParse(input);
  if (!parsed.success) return { problem: "An entry without a usable type and name was left out" };
  const { title, ...rest } = parsed.data;
  const extra: Record<string, unknown> = {};
  if (typeof input === "object" && input !== null)
    for (const [key, value] of Object.entries(input)) if (!known.has(key)) extra[key] = value;
  return {
    ...rest,
    title: title ?? rest.name,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

export const isSupportedType = (type: string, supported: readonly string[]) =>
  MarketEntryType.safeParse(type).success && supported.includes(type);

const IndexBody = z.object({
  stamp: z.number().int().nonnegative(),
  /** False for a `since` answer: entries changed since then, and the ones removed. */
  full: z.boolean(),
  entries: z.array(z.unknown()).max(50_000),
  removed: z
    .array(z.object({ type: z.string().max(40), name: z.string().max(64) }))
    .max(50_000)
    .default([]),
});
export type IndexBody = z.infer<typeof IndexBody>;

export interface ParsedIndex {
  stamp: number;
  full: boolean;
  entries: FeedEntry[];
  removed: { type: string; name: string }[];
  problems: string[];
}

export class FeedError extends Error {
  override name = "FeedError";
}

/** `/v1/index` (or a git catalog's entries, mapped the same way). */
export function parseIndex(input: unknown): ParsedIndex {
  const body = IndexBody.safeParse(input);
  if (!body.success) throw new FeedError("The index isn't in a form this build reads");
  const entries: FeedEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.data.entries) {
    const entry = readFeedEntry(raw);
    if ("problem" in entry) {
      problems.push(entry.problem);
      continue;
    }
    const key = entryKey(entry);
    if (seen.has(key)) throw new FeedError(`The index lists ${key} twice`);
    seen.add(key);
    entries.push(entry);
  }
  return {
    stamp: body.data.stamp,
    full: body.data.full,
    entries,
    removed: body.data.removed,
    problems,
  };
}

/** The cached listing after `delta`: a full answer replaces it, a `since` answer merges. */
export function mergeIndex(previous: readonly FeedEntry[], delta: ParsedIndex): FeedEntry[] {
  if (delta.full) return [...delta.entries];
  const merged = new Map(previous.map((entry) => [entryKey(entry), entry]));
  for (const removed of delta.removed) merged.delete(entryKey(removed));
  for (const entry of delta.entries) merged.set(entryKey(entry), entry);
  return [...merged.values()];
}

/** The items of `list` that parse; the rest are dropped, as unusable display values are. */
function keepParsed<T>(list: readonly unknown[], schema: z.ZodType<T>): T[] {
  return list.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export const CategoriesBody = z.object({
  categories: z
    .array(z.unknown())
    .max(64)
    .transform((list) => keepParsed(list, MarketCategory)),
});
export const FeaturedBody = z.object({
  entries: z.array(z.object({ type: z.string().max(40), name: z.string().max(64) })).max(64),
});

/** `/v1/entries/{type}/{name}`. */
export const EntryBody = z.object({
  entry: z.unknown(),
  description: z.string().max(8192).catch(""),
  versions: z
    .array(z.unknown())
    .max(200)
    .transform((list) => keepParsed(list, MarketEntryVersion)),
});
export type EntryBody = z.infer<typeof EntryBody>;

/** `/v1/entries/{type}/{name}/{version}`: the signed manifest and, if reviewed, its mark. */
export const VersionBody = z.object({
  manifest: Signed,
  review: Signed.optional(),
});
export type VersionBody = z.infer<typeof VersionBody>;
