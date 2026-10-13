import { useCallback, useEffect, useSyncExternalStore } from "react";
import { addressHost } from "@ace/ui-core";
import type { PreviewSource } from "../sources.ts";
import { useVisited } from "../browser/browser-state.ts";

/** One tile of the new tab's Suggested row. */
export interface SuggestedSite {
  url: string;
  title: string;
  /** "localhost:5173", or the site's host. */
  detail: string;
  /** The daemon's favicon for it, when it has one. */
  iconUrl?: string | undefined;
  /** A dev server's port: it opens in Preview rather than the Browser. */
  port?: number | undefined;
}

/** How many recent pages follow the dev servers. */
const recentCount = 8;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return addressHost(url) ?? url;
  }
};

/**
 * What the new tab suggests opening: the thread's local dev servers first (those the daemon
 * detected for its project and those it already previews), then the pages its Browser visited.
 * Follows the source while the launcher shows.
 */
export function useSuggested(source: PreviewSource, threadId: string): SuggestedSite[] {
  // The source's reads change with its version; this hook opts out of memoizing them.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  useEffect(() => source.watch(threadId), [source, threadId]);
  const visited = useVisited(threadId);

  const sites: SuggestedSite[] = [];
  const seen = new Set<string>();
  const add = (site: SuggestedSite) => {
    const key = site.port === undefined ? site.url : `port:${site.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push(site);
  };
  for (const found of source.suggestions(threadId))
    add({
      url: found.url,
      title: found.title || hostOf(found.url),
      detail: hostOf(found.url),
      iconUrl: found.iconUrl,
      port: found.port,
    });
  for (const server of source.servers(threadId)) {
    const url = server.origin ?? `http://localhost:${server.port}`;
    add({
      url,
      title: server.name ?? hostOf(url),
      detail: `localhost:${server.port}`,
      port: server.port,
    });
  }
  for (const url of visited.slice(0, recentCount))
    add({ url, title: hostOf(url), detail: url.replace(/^https?:\/\//, "") });
  return sites;
}
