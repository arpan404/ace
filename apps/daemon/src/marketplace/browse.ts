import type {
  MarketEntryDetail,
  MarketInstalled,
  MarketOperation,
  MarketResult,
} from "@ace/protocol/marketplace";
import { entryKey, search, verifyManifest, type FeedEntry } from "@ace/marketplace";
import { EntryBody, VersionBody, type MarketKeySet } from "@ace/protocol/marketplace";
import type { MarketHttp } from "./http.ts";
import { marketError } from "./market-error.ts";
import {
  markedPublisher,
  readWithdrawn,
  summaryOf,
  withdrawalOf,
  type RowMarks,
} from "./listings.ts";
import { approvedForBots, verifiedKey, type MarketStore, type StoredInstall } from "./store.ts";

/*
 * Browsing the daemon's copy of every listing (ADR 0168 §3, §11): search, the home page's
 * featured entries and categories, and an entry's page. Only an entry page asks the market for
 * more (its description and versions), and shows what the listing has when it can't.
 */

/** An install as the wire shows it, without what only the daemon keeps. */
export function publicInstall(install: StoredInstall): MarketInstalled {
  const {
    files: _files,
    description: _description,
    pluginCommit: _pin,
    bundledBy: _by,
    signed: _signed,
    publisher: _publisher,
    approvedHash: _approved,
    ...rest
  } = install;
  return install.type === "spade-skill"
    ? { ...rest, botsApproved: approvedForBots(install) }
    : rest;
}

async function enabledListings(store: MarketStore) {
  const sources = store.sources().filter((source) => source.enabled);
  return Promise.all(
    sources.map(async (source) => ({ source, listing: await store.listing(source.id) })),
  );
}

/** Search, each publisher's tier from the signed lists (ADR 0174 §15). */
export async function searchListings(
  store: MarketStore,
  operation: Extract<MarketOperation, { op: "search" }>,
  marks: RowMarks,
): Promise<MarketResult> {
  const lists = await enabledListings(store);
  const rows = lists.flatMap(({ source, listing }) =>
    listing.entries.map((entry) => ({
      ...summaryOf(source, entry, marks),
      tier:
        source.kind === "market"
          ? marks.badges.tier(markedPublisher(entry, marks))
          : ("other" as const),
    })),
  );
  const found = search(rows, operation);
  const read = lists.map(({ source }) => source.readAt ?? 0);
  return {
    op: "search",
    entries: found
      .slice(operation.offset, operation.offset + operation.limit)
      .map(({ tier: _tier, ...summary }) => summary),
    total: found.length,
    ...(read.length && Math.min(...read) > 0 ? { readAt: Math.min(...read) } : {}),
  };
}

/** Featured and categories hold reviewed entries only. */
export async function homeOf(
  store: MarketStore,
  installed: readonly MarketInstalled[],
  marks: RowMarks,
): Promise<MarketResult> {
  const lists = await enabledListings(store);
  const market = lists.find(({ source }) => source.kind === "market");
  const summaries = new Map(
    lists.flatMap(({ source, listing }) =>
      listing.entries.map(
        (entry) => [`${source.id}:${entryKey(entry)}`, summaryOf(source, entry, marks)] as const,
      ),
    ),
  );
  const featured = (market?.listing.featured ?? []).flatMap((key) => {
    const summary = summaries.get(`market:${entryKey(key)}`);
    return summary?.reviewed ? [summary] : [];
  });
  const reviewed = [...summaries.values()].filter((summary) => summary.reviewed);
  return {
    op: "home",
    featured: featured.slice(0, 24),
    categories: (market?.listing.categories ?? []).slice(0, 32).map((category) => ({
      id: category.id,
      title: category.title,
      entries: reviewed.filter((summary) => summary.categories.includes(category.id)).length,
    })),
    installed: installed.length,
    updates: installed.filter((item) => item.update).length,
  };
}

/**
 * Verifies the signed manifest of the listed version and records its publisher, so the entry's
 * marks can rest on it. A manifest that doesn't verify, or names another entry, records nothing.
 */
async function verifyListed(
  store: MarketStore,
  http: MarketHttp,
  keys: MarketKeySet,
  entry: FeedEntry,
): Promise<void> {
  if (!entry.version) return;
  const body = VersionBody.safeParse(await http.version(entry.type, entry.name, entry.version));
  if (!body.success) return;
  let manifest;
  try {
    manifest = verifyManifest(body.data.manifest, keys);
  } catch {
    return;
  }
  if (
    manifest.type !== entry.type ||
    manifest.name !== entry.name ||
    manifest.version !== entry.version
  )
    return;
  store.saveVerifiedPublisher(verifiedKey(manifest), manifest.publisher.id);
}

export async function readEntry(
  ports: { store: MarketStore; http: MarketHttp | undefined; keys: MarketKeySet },
  marks: () => RowMarks,
  sourceId: string,
  type: string,
  name: string,
): Promise<MarketEntryDetail | undefined> {
  const { store, http } = ports;
  const source = store.source(sourceId);
  if (!source) return undefined;
  const listing = await store.listing(source.id);
  const entry = listing.entries.find((item) => item.type === type && item.name === name);
  if (!entry) return undefined;
  if (source.kind === "git")
    return {
      summary: summaryOf(source, entry, marks()),
      description: listing.folders?.[entryKey(entry)]?.description ?? "",
      versions: [],
    };
  const detail: MarketEntryDetail = {
    summary: summaryOf(source, entry, marks()),
    description: "",
    versions: [],
  };
  try {
    const page = http ? EntryBody.safeParse(await http.entry(type, name)) : undefined;
    if (page?.success) {
      detail.description = page.data.description;
      const state = readWithdrawn(store);
      detail.versions = page.data.versions;
      for (const version of detail.versions) {
        const reason =
          withdrawalOf(state, source.id, { type, name, ...version }) ?? version.withdrawn;
        if (reason) version.withdrawn = reason.slice(0, 500);
      }
    }
    if (http) await verifyListed(store, http, ports.keys, entry);
  } catch {
    // Offline: the page shows what the listing has.
  }
  detail.summary = summaryOf(source, entry, marks());
  return detail;
}

/** An entry's page, with its install when it was installed from this source. */
export async function readListed(
  ports: { store: MarketStore; http: MarketHttp | undefined; keys: MarketKeySet },
  marks: () => RowMarks,
  sourceId: string,
  type: string,
  name: string,
): Promise<MarketResult> {
  const detail = await readEntry(ports, marks, sourceId, type, name);
  if (!detail) return marketError("not_found", `${type}/${name} isn't listed`);
  const installed = ports.store.install(type, name);
  if (installed && installed.source === sourceId) detail.installed = publicInstall(installed);
  return { op: "read", entry: detail };
}
