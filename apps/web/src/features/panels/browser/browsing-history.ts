import { BrowsingHistory, type Visit } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

export { searchVisits, type Visit } from "@ace/ui-core";

const stores = new WeakMap<object, BrowsingHistory>();
let unstored: BrowsingHistory | undefined;

/** This device's browsing history (`@ace/ui-core`), kept in the layout's storage. */
export function useBrowsingHistory(): BrowsingHistory {
  const { storage } = useLayout();
  if (!storage) return (unstored ??= new BrowsingHistory(undefined));
  let store = stores.get(storage);
  if (!store) {
    store = new BrowsingHistory(storage);
    stores.set(storage, store);
  }
  return store;
}

/** A thread's visits, kept current. */
export function useVisits(threadId: string): readonly Visit[] {
  const store = useBrowsingHistory();
  const read = useCallback(() => store.visits(threadId), [store, threadId]);
  return useSyncExternalStore(store.subscribe, read);
}
