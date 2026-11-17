import {
  marketFeedFields,
  MarketEntryType,
  MarketFeedEntryWire,
  MarketIndexBody,
  type MarketPublisher,
} from "@ace/protocol/marketplace";

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
  /** The publisher carries ace's verified mark (ADR 0173 §3). */
  verified?: boolean | undefined;
  /** The latest version is deprecated, with this note. */
  deprecated?: string | undefined;
  /** Listing pictures by sha256 (ADR 0173 §5). */
  previews?: string[] | undefined;
  /** Fields this build doesn't know, kept as they came. */
  extra?: Record<string, unknown> | undefined;
}

const known = new Set<string>(marketFeedFields);

export const entryKey = (entry: { type: string; name: string }) => `${entry.type}/${entry.name}`;

/** One entry from the wire, or a note saying why it was left out. */
export function readFeedEntry(input: unknown): FeedEntry | { problem: string } {
  const parsed = MarketFeedEntryWire.safeParse(input);
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

export type IndexBody = MarketIndexBody;

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
  const body = MarketIndexBody.safeParse(input);
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
