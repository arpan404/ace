import { useScopedRecent, useScopedRecentStore, type ScopedRecent } from "../recent-store.ts";

/** Addresses each thread's browser visited, for the address bar's suggestions. */
const visited = { key: "ace.browser.visited", perScope: 16, scopes: 64 };

export function useVisitedStore(): ScopedRecent {
  return useScopedRecentStore(visited);
}

export function useVisited(threadId: string): readonly string[] {
  return useScopedRecent(useVisitedStore(), threadId);
}
