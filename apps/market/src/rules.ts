import type { FeedEntry, Listing } from "@ace/marketplace";
import type { MarketEntryVersion, MarketPublisher } from "@ace/protocol/marketplace";

/*
 * The listing rules (ADR 0168 §3, §6, §7, §11). Pure: what the store read in, what readers see
 * out.
 *
 * - A version is public once the signer signed its manifest.
 * - An entry's latest is its newest signed version that isn't withdrawn; its words, review and
 *   place in the index come from that version. With none, it leaves the index (a withdrawn
 *   version stays fetchable by hash, so whoever installed it can reinstall).
 * - Only reviewed entries are listed under categories or featured.
 */

export interface StoredVersion {
  version: string;
  hash: string;
  size: number;
  published: number;
  listing: Listing;
  /** Signed by the signer. */
  listed: boolean;
  withdrawn: string | undefined;
  reviewed: boolean;
  byAce: boolean;
  downloads: number;
}

export interface EntryState {
  listed: boolean;
  latest: string | undefined;
  title: string;
  line: string;
  description: string;
  categories: string[];
  keywords: string[];
  reviewed: boolean;
  byAce: boolean;
}

const release = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** Version order: numbers first, then a release after its pre-releases, then the tag's text. */
export function compareVersions(a: string, b: string): number {
  const left = release.exec(a);
  const right = release.exec(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  const [leftTag, rightTag] = [left[4], right[4]];
  if (leftTag === rightTag) return 0;
  if (leftTag === undefined) return 1;
  if (rightTag === undefined) return -1;
  return leftTag < rightTag ? -1 : 1;
}

export const newestFirst = <T extends { version: string }>(versions: readonly T[]): T[] =>
  versions.toSorted((a, b) => compareVersions(b.version, a.version));

/** The entry as its versions make it. */
export function entryState(name: string, versions: readonly StoredVersion[]): EntryState {
  const signed = newestFirst(versions.filter((version) => version.listed));
  const latest = signed.find((version) => version.withdrawn === undefined);
  const words = (latest ?? signed[0])?.listing;
  return {
    listed: latest !== undefined,
    latest: latest?.version,
    title: words?.title ?? name,
    line: words?.line ?? "",
    description: words?.description ?? "",
    categories: words?.categories ?? [],
    keywords: words?.keywords ?? [],
    reviewed: latest?.reviewed ?? false,
    byAce: latest?.byAce ?? false,
  };
}

export const sameState = (a: EntryState, b: EntryState) => JSON.stringify(a) === JSON.stringify(b);

export interface EntryRow extends EntryState {
  type: string;
  name: string;
  publisher: MarketPublisher;
  updated: number;
  downloads: number;
}

/** An entry as the index lists it. An entry not reviewed names no categories. */
export function summary(entry: EntryRow): FeedEntry {
  return {
    type: entry.type,
    name: entry.name,
    title: entry.title,
    line: entry.line,
    publisher: entry.publisher,
    categories: entry.reviewed ? entry.categories : [],
    keywords: entry.keywords,
    ...(entry.latest ? { version: entry.latest } : {}),
    reviewed: entry.reviewed,
    byAce: entry.byAce,
    updated: entry.updated,
    downloads: entry.downloads,
  };
}

/** An entry page's versions: signed ones only, newest first, with withdrawal reasons. */
export function publicVersions(versions: readonly StoredVersion[]): MarketEntryVersion[] {
  return newestFirst(versions.filter((version) => version.listed)).map((version) => {
    const row: MarketEntryVersion = {
      version: version.version,
      hash: version.hash,
      size: version.size,
      published: version.published,
      downloads: version.downloads,
    };
    if (version.withdrawn !== undefined) row.withdrawn = version.withdrawn;
    return row;
  });
}

/** The featured list as readers see it: entries still listed and reviewed, in order. */
export function visibleFeatured(
  featured: readonly { type: string; name: string }[],
  entries: ReadonlyMap<string, { listed: boolean; reviewed: boolean }>,
): { type: string; name: string }[] {
  return featured.filter((item) => {
    const entry = entries.get(`${item.type}/${item.name}`);
    return entry?.listed === true && entry.reviewed;
  });
}
