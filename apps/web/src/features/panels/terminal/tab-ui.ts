import { useCallback } from "react";
import { LocalStore, useLocal } from "../store.ts";

/*
 * Per-tab view state the strip's actions and the tab's view share: whether Find is open and
 * whether the rename dialog is. Client-only and not persisted (a reload closes both).
 */

export interface TabUi {
  find: boolean;
  rename: boolean;
}

export type TabUiState = ReadonlyMap<string, TabUi>;

const closed: TabUi = { find: false, rename: false };
/** Tabs whose state is kept; the least recently changed are forgotten first. */
const keptTabs = 128;

export function createTabUi(): LocalStore<TabUiState> {
  return new LocalStore<TabUiState>(new Map());
}

export function setTabUi(store: LocalStore<TabUiState>, key: string, patch: Partial<TabUi>): void {
  store.set((previous) => {
    const current = previous.get(key) ?? closed;
    const next = { ...current, ...patch };
    if (next.find === current.find && next.rename === current.rename) return previous;
    const map = new Map(previous);
    map.delete(key);
    map.set(key, next);
    for (const [oldest] of map) {
      if (map.size <= keptTabs) break;
      map.delete(oldest);
    }
    return map;
  });
}

export function useTabUi(store: LocalStore<TabUiState>, key: string): TabUi {
  const select = useCallback((state: TabUiState) => state.get(key) ?? closed, [key]);
  return useLocal(store, select);
}
