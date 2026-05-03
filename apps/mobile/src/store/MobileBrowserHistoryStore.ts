import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  BROWSER_HISTORY_STORAGE_KEY,
  recordBrowserHistory,
  type BrowserHistory,
  type BrowserHistoryEntry,
} from "@ace/shared/browserHistory";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface MobileBrowserHistoryState {
  readonly history: BrowserHistory;
  readonly clearHistory: () => void;
  readonly recordVisit: (entry: BrowserHistoryEntry) => void;
}

function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<BrowserHistoryEntry>;
  return (
    typeof entry.title === "string" &&
    typeof entry.url === "string" &&
    typeof entry.visitedAt === "number" &&
    typeof entry.visitCount === "number"
  );
}

export function mergeMobileBrowserHistoryState(
  persisted: unknown,
  current: MobileBrowserHistoryState,
): MobileBrowserHistoryState {
  if (typeof persisted !== "object" || persisted === null) {
    return current;
  }
  const history = (persisted as { history?: unknown }).history;
  return {
    ...current,
    history: Array.isArray(history) ? history.filter(isHistoryEntry) : current.history,
  };
}

export const useMobileBrowserHistoryStore = create<MobileBrowserHistoryState>()(
  persist(
    (set) => ({
      history: [],
      clearHistory: () => set({ history: [] }),
      recordVisit: (entry) =>
        set((state) => ({
          history: recordBrowserHistory(state.history, entry),
        })),
    }),
    {
      name: BROWSER_HISTORY_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      merge: mergeMobileBrowserHistoryState,
      partialize: (state) => ({
        history: state.history,
      }),
    },
  ),
);
