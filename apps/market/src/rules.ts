import type { FeedEntry, Listing } from "@ace/marketplace";
import type {
  MarketEntryVersion,
  MarketListingEdit,
  MarketPublisher,
  MarketVersionStatus,
} from "@ace/protocol/marketplace";

/*
 * The listing rules (ADR 0168 §3, §6, §7, §11). Pure: what the store read in, what readers see
 * out.
 *
 * - A version is public once the signer signed its manifest.
 * - An entry's latest is the live version its publisher picked, else its newest signed version
 *   that isn't withdrawn; its review and place in the index come from that version, its words
 *   from an approved listing edit over that version's own (ADR 0173 §5). With no live version
 *   it leaves the index (a withdrawn version stays fetchable by hash, so whoever installed it
 *   can reinstall).
 * - The index lists an entry only with a live version, listed visibility, not archived and its
 *   publisher active. An unlisted or archived entry keeps its page.
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
  /** Its way through the scan and the signer: pending, held, blocked or listed (ADR 0173 §9). */
  state?: VersionState | undefined;
  blockReason?: string | undefined;
  deprecated?: string | undefined;
  changelog?: string | undefined;
}

export type VersionState = "pending" | "held" | "blocked" | "listed";

/** What a publisher set on an entry, and its publisher's standing (ADR 0173 §5). */
export interface EntryManagement {
  visibility: "listed" | "unlisted";
  archived: boolean;
  /** The live version the publisher picked; absent, or no longer live, means the newest. */
  latestPick: string | undefined;
  /** An approved listing edit, shown over the version's own words. */
  listing: MarketListingEdit | undefined;
  publisherActive: boolean;
  publisherVerified: boolean;
}

export const plainManagement: EntryManagement = {
  visibility: "listed",
  archived: false,
  latestPick: undefined,
  listing: undefined,
  publisherActive: true,
  publisherVerified: false,
};

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
  /** The publisher carries the verified mark. */
  verified: boolean;
  /** The latest version's deprecation note. */
  deprecated: string | undefined;
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

/** Signed versions that aren't withdrawn, newest first. */
export const liveVersions = <T extends StoredVersion>(versions: readonly T[]): T[] =>
  newestFirst(versions.filter((version) => version.listed && version.withdrawn === undefined));

/** The entry as its versions and its publisher's settings make it. */
export function entryState(
  name: string,
  versions: readonly StoredVersion[],
  manage: EntryManagement = plainManagement,
): EntryState {
  const signed = newestFirst(versions.filter((version) => version.listed));
  const live = liveVersions(versions);
  const latest = live.find((version) => version.version === manage.latestPick) ?? live[0];
  const own = (latest ?? signed[0])?.listing;
  const words = manage.listing ?? own;
  return {
    listed:
      latest !== undefined &&
      manage.visibility === "listed" &&
      !manage.archived &&
      manage.publisherActive,
    latest: latest?.version,
    title: words?.title ?? name,
    line: words?.line ?? "",
    description: words?.description ?? "",
    categories: words?.categories ?? [],
    keywords: words?.keywords ?? [],
    reviewed: latest?.reviewed ?? false,
    byAce: latest?.byAce ?? false,
    verified: manage.publisherVerified,
    deprecated: latest?.deprecated,
  };
}

/** A version's status on its publisher's page (ADR 0173 §4). */
export function versionStatus(version: StoredVersion): {
  status: MarketVersionStatus;
  held: boolean;
  reason?: string;
} {
  if (version.state === "blocked")
    return {
      status: "blocked",
      held: false,
      reason: version.blockReason ?? "Refused by the scan.",
    };
  if (version.withdrawn !== undefined)
    return { status: "withdrawn", held: false, reason: version.withdrawn };
  if (version.listed) return { status: version.reviewed ? "live" : "not-reviewed", held: false };
  return { status: "waiting", held: version.state === "held" };
}

/** The listing words an entry shows to its publisher: the approved edit, else the version's. */
export function currentListing(
  name: string,
  versions: readonly StoredVersion[],
  manage: EntryManagement,
): MarketListingEdit {
  if (manage.listing) return manage.listing;
  const state = entryState(name, versions, manage);
  const newest = newestFirst(versions)[0]?.listing;
  const words = state.latest ? state : newest;
  return {
    title: (words?.title ?? name) || name,
    line: words?.line ?? "",
    description: words?.description ?? "",
    categories: words?.categories ?? [],
    keywords: words?.keywords ?? [],
    links: [],
    previews: [],
  };
}

/** Whether a publisher is new, with stricter thresholds (ADR 0173 §9). */
export const newPublisherDays = 30;
export function isNewPublisher(publisher: { created: number; liveVersions: number }, now: number) {
  return now - publisher.created < newPublisherDays * 86_400_000 || publisher.liveVersions < 3;
}

/** A publisher's limits (ADR 0173 §9): uploads a day, stored bytes, drafts. */
const MiB = 1024 * 1024;
export function publisherLimits(newPublisher: boolean) {
  return {
    uploadsPerDay: newPublisher ? 10 : 30,
    quotaBytes: newPublisher ? 256 * MiB : 1024 * MiB,
    draftLimit: 20,
  };
}

/** The day a time falls on, in days since the Unix epoch. */
export const dayOf = (time: number) => Math.floor(time / 86_400_000);

export const sameState = (a: EntryState, b: EntryState) => JSON.stringify(a) === JSON.stringify(b);

export interface EntryRow extends EntryState {
  type: string;
  name: string;
  publisher: MarketPublisher;
  updated: number;
  downloads: number;
  /** The approved listing edit's pictures, by sha256. */
  previews?: readonly string[] | undefined;
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
    verified: entry.verified,
    ...(entry.deprecated !== undefined ? { deprecated: entry.deprecated } : {}),
    ...(entry.previews?.length ? { previews: [...entry.previews] } : {}),
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
