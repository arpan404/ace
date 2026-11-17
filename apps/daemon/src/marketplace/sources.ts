import type { MarketResult } from "@ace/protocol/marketplace";
import { marketError as error } from "./market-error.ts";
import type { MarketStore, StoredSource } from "./store.ts";

/*
 * The sources the marketplace reads: market.acehq.dev and the git catalogs a person added, each
 * answered with how many entries the daemon's copy of its listing holds.
 */

/** Every source, with the size of its stored listing. */
export async function sourcesOf(store: MarketStore): Promise<MarketResult> {
  const sources: Extract<MarketResult, { op: "sources" }>["sources"] = [];
  for (const source of store.sources())
    sources.push({
      id: source.id,
      kind: source.kind,
      address: source.address,
      enabled: source.enabled,
      ...(source.readAt === undefined ? {} : { readAt: source.readAt }),
      ...(source.problem ? { problem: source.problem } : {}),
      entries: (await store.listing(source.id)).entries.length,
    });
  return { op: "sources", sources };
}

/**
 * Saves a git catalog by its https address (a local path only when `allowLocalGit`), or answers
 * why it can't be added. The caller reads it.
 */
export function saveGitSource(
  store: MarketStore,
  address: string,
  options: { id: () => string; allowLocalGit: boolean },
): StoredSource | MarketResult {
  const local = options.allowLocalGit && address.startsWith("/");
  if (!local) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return error("invalid", "A catalog is added by its https git address");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      return error(
        "invalid",
        "A catalog is added by its https git address, with no password in it",
      );
  }
  if (store.sources().some((source) => source.address === address))
    return error("conflict", "That catalog is already added");
  if (store.sources().length >= 32) return error("refused", "At most 32 sources");
  const id = `git:${
    options
      .id()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 32) || "catalog"
  }`;
  const source: StoredSource = { id, kind: "git", address, enabled: true };
  store.saveSource(source);
  return source;
}
