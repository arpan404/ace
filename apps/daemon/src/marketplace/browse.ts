import type {
  MarketEntryDetail,
  MarketInstalled,
  MarketOperation,
  MarketResult,
} from "@ace/protocol/marketplace";
import { EntryBody, entryKey, search } from "@ace/marketplace";
import type { MarketHttp } from "./http.ts";
import { readWithdrawn, summaryOf, withdrawalOf } from "./listings.ts";
import type { MarketStore, StoredInstall } from "./store.ts";

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
    ...rest
  } = install;
  return rest;
}

async function enabledListings(store: MarketStore) {
  const sources = store.sources().filter((source) => source.enabled);
  return Promise.all(
    sources.map(async (source) => ({ source, listing: await store.listing(source.id) })),
  );
}

export async function searchListings(
  store: MarketStore,
  operation: Extract<MarketOperation, { op: "search" }>,
): Promise<MarketResult> {
  const lists = await enabledListings(store);
  const summaries = lists.flatMap(({ source, listing }) =>
    listing.entries.map((entry) => summaryOf(source, entry)),
  );
  const found = search(summaries, operation);
  const read = lists.map(({ source }) => source.readAt ?? 0);
  return {
    op: "search",
    entries: found.slice(operation.offset, operation.offset + operation.limit),
    total: found.length,
    ...(read.length && Math.min(...read) > 0 ? { readAt: Math.min(...read) } : {}),
  };
}

/** Featured and categories hold reviewed entries only. */
export async function homeOf(
  store: MarketStore,
  installed: readonly MarketInstalled[],
): Promise<MarketResult> {
  const lists = await enabledListings(store);
  const market = lists.find(({ source }) => source.kind === "market");
  const summaries = new Map(
    lists.flatMap(({ source, listing }) =>
      listing.entries.map(
        (entry) => [`${source.id}:${entryKey(entry)}`, summaryOf(source, entry)] as const,
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

export async function readEntry(
  store: MarketStore,
  http: MarketHttp | undefined,
  sourceId: string,
  type: string,
  name: string,
): Promise<MarketEntryDetail | undefined> {
  const source = store.source(sourceId);
  if (!source) return undefined;
  const listing = await store.listing(source.id);
  const entry = listing.entries.find((item) => item.type === type && item.name === name);
  if (!entry) return undefined;
  const detail: MarketEntryDetail = {
    summary: summaryOf(source, entry),
    description: "",
    versions: [],
  };
  if (source.kind === "git") {
    detail.description = listing.folders?.[entryKey(entry)]?.description ?? "";
    return detail;
  }
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
  } catch {
    // Offline: the page shows what the listing has.
  }
  return detail;
}
