import { LocalStore } from "../store.ts";

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
