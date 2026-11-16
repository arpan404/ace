import { installableMarketTypes, type MarketEntrySummary } from "@ace/protocol/marketplace";
import {
  catalogFeedEntry,
  isSupportedType,
  mergeIndex,
  parseIndex,
  verifyWithdrawn,
  withdrawalKey,
  withdrawalReason,
  type FeedEntry,
  type WithdrawalTarget,
} from "@ace/marketplace";
import {
  CategoriesBody,
  FeaturedBody,
  type Withdrawal,
  type MarketKeySet,
} from "@ace/protocol/marketplace";
import type { GitCatalogs } from "./git.ts";
import type { MarketHttp } from "./http.ts";
import { storedMarketWithdrawn } from "../stored-decode.ts";
import type { MarketStore, StoredListing, StoredSource } from "./store.ts";

/*
 * Reading each source's listing into the daemon's copy (ADR 0168 §3, §9): the market's index as
 * a delta since the last read, its categories, featured list and signed withdrawn list; a git
 * catalog's entries at its current commit. A read that fails keeps the last listing and says when
 * it was read.
 */

export const withdrawnKey = "withdrawn";

export interface WithdrawnState {
  issued: number;
  /**
   * Every withdrawal a verified list ever held, so replaying an older list never undoes one: a
   * publisher's of one version, or a maintainer's of bytes wherever they are.
   */
  withdrawn: Withdrawal[];
}

export function readWithdrawn(store: MarketStore): WithdrawnState {
  const raw = store.meta(withdrawnKey);
  return raw ? storedMarketWithdrawn(raw) : { issued: 0, withdrawn: [] };
}

/**
 * Why an entry from `source` is withdrawn, if it is. A maintainer's revocation covers its bytes
 * from any source; a publisher's withdrawal covers only that market entry's version.
 */
export function withdrawalOf(
  state: WithdrawnState,
  source: string,
  target: WithdrawalTarget,
): string | undefined {
  const applies =
    source === "market"
      ? state.withdrawn
      : state.withdrawn.filter((entry) => entry.scope === "hash");
  return withdrawalReason(applies, target);
}

/**
 * Reads the market's signed withdrawn list and keeps it if it is newer than the one held. Every
 * hash a verified list ever named stays withdrawn, so replaying an older list undoes nothing.
 */
export async function learnWithdrawn(
  store: MarketStore,
  http: MarketHttp | undefined,
  keys: MarketKeySet,
): Promise<void> {
  if (!http) return;
  const signed = await http.withdrawn();
  if (signed === undefined) return;
  const list = verifyWithdrawn(signed, keys);
  const state = readWithdrawn(store);
  if (list.issued <= state.issued) return;
  const known = new Set(state.withdrawn.map(withdrawalKey));
  for (const entry of list.withdrawn)
    if (!known.has(withdrawalKey(entry))) state.withdrawn.push(entry);
  state.issued = list.issued;
  store.setMeta(withdrawnKey, JSON.stringify(state));
}

async function readMarket(
  store: MarketStore,
  http: MarketHttp,
  keys: MarketKeySet,
  source: StoredSource,
): Promise<StoredSource> {
  const previous = await store.listing(source.id);
  const since =
    source.stamp !== undefined && previous.entries.length > 0
      ? { stamp: source.stamp, etag: source.etag }
      : undefined;
  const answer = await http.index(since);
  let next: StoredListing = previous;
  let stamp = source.stamp;
  let etag = source.etag;
  if (!answer.unchanged) {
    const index = parseIndex(answer.body);
    next = { ...previous, entries: mergeIndex(previous.entries, index) };
    stamp = index.stamp;
    etag = answer.etag;
  }
  const categories = CategoriesBody.safeParse(await http.categories());
  const featured = FeaturedBody.safeParse(await http.featured());
  next = {
    ...next,
    categories: categories.success ? categories.data.categories : next.categories,
    featured: featured.success ? featured.data.entries : next.featured,
  };
  await learnWithdrawn(store, http, keys);
  await store.saveListing(source.id, next);
  return { ...source, stamp, etag };
}

async function readGit(
  store: MarketStore,
  git: GitCatalogs,
  source: StoredSource,
  now: number,
): Promise<StoredSource> {
  const { commit, catalog } = await git.read(source.address);
  const folders: NonNullable<StoredListing["folders"]> = {};
  for (const entry of catalog.entries)
    folders[`${entry.type}/${entry.name}`] = {
      source: entry.source,
      hash: entry.hash,
      description: entry.description,
    };
  await store.saveListing(source.id, {
    entries: catalog.entries.map((entry) => catalogFeedEntry(entry, now)),
    categories: [],
    featured: [],
    folders,
  });
  return { ...source, commit };
}

/** Reads one source; on failure keeps its listing and records why. */
export async function refreshSource(
  deps: {
    store: MarketStore;
    http: MarketHttp | undefined;
    git: GitCatalogs;
    keys: MarketKeySet;
    now: () => number;
  },
  source: StoredSource,
): Promise<StoredSource> {
  let next: StoredSource;
  try {
    if (source.kind === "market") {
      if (!deps.http) throw new Error("market.acehq.dev is turned off");
      next = await readMarket(deps.store, deps.http, deps.keys, source);
    } else next = await readGit(deps.store, deps.git, source, deps.now());
    next = { ...next, readAt: deps.now(), problem: undefined };
  } catch (error) {
    next = {
      ...source,
      problem: (error instanceof Error ? error.message : "The read failed").slice(0, 500),
    };
  }
  deps.store.saveSource(next);
  return next;
}

export function summaryOf(source: StoredSource, entry: FeedEntry): MarketEntrySummary {
  return {
    source: source.id as MarketEntrySummary["source"],
    type: entry.type,
    name: entry.name,
    title: entry.title,
    line: entry.line,
    ...(entry.publisher ? { publisher: entry.publisher } : {}),
    categories: entry.categories,
    keywords: entry.keywords,
    ...(entry.version ? { version: entry.version } : {}),
    reviewed: source.kind === "market" && entry.reviewed,
    byAce: source.kind === "market" && entry.byAce,
    updated: entry.updated,
    downloads: entry.downloads,
    supported: isSupportedType(entry.type, installableMarketTypes),
    ...(source.kind === "git" ? { from: source.address } : {}),
  };
}
