import { LocalStore } from "../store.ts";

/*
 * The browser tabs' shared session state, small enough to load with the tab kinds: which tab
 * drives each thread's page, and which tabs are loading.
 */

/** Which browser tab drives each thread's page (thread id → tab key), for this session. */
export const pageOwners = new LocalStore<ReadonlyMap<string, string>>(new Map());

export function bindPage(threadId: string, tabKey: string | undefined) {
  pageOwners.set((owners) => {
    if (owners.get(threadId) === tabKey) return owners;
    const next = new Map(owners);
    if (tabKey) next.set(threadId, tabKey);
    else next.delete(threadId);
    return next;
  });
}

/** Browser tabs with a navigation in flight (`threadId\0tabKey`), for their strip spinner. */
export const loadingTabs = new LocalStore<ReadonlySet<string>>(new Set());

export const loadingKey = (threadId: string, tabKey: string) => `${threadId}\u0000${tabKey}`;

export function setLoading(threadId: string, tabKey: string, loading: boolean) {
  const key = loadingKey(threadId, tabKey);
  loadingTabs.set((current) => {
    if (current.has(key) === loading) return current;
    const next = new Set(current);
    if (loading) next.add(key);
    else next.delete(key);
    return next;
  });
}

/** A fresh id for a new browser tab of a scope: one past the highest in use. */
export function nextBrowserId(keys: readonly string[]): string {
  const taken = keys
    .filter((key) => key.startsWith("browser:"))
    .map((key) => Number(key.slice("browser:".length)) || 0);
  return String(Math.max(0, ...taken) + 1);
}
