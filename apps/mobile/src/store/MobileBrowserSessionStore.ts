import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MOBILE_BROWSER_SESSION_STORAGE_KEY = "ace-mobile-browser-session-v1";
const MAX_MOBILE_BROWSER_TABS = 24;

export interface MobileBrowserSessionTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

interface MobileBrowserSessionState {
  readonly activeTabId: string | null;
  readonly tabs: ReadonlyArray<MobileBrowserSessionTab>;
  readonly clearSession: () => void;
  readonly setSession: (
    tabs: ReadonlyArray<MobileBrowserSessionTab>,
    activeTabId: string | null,
  ) => void;
}

function isSessionTab(value: unknown): value is MobileBrowserSessionTab {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tab = value as Partial<MobileBrowserSessionTab>;
  return (
    typeof tab.id === "string" &&
    tab.id.trim().length > 0 &&
    typeof tab.url === "string" &&
    typeof tab.title === "string" &&
    typeof tab.canGoBack === "boolean" &&
    typeof tab.canGoForward === "boolean"
  );
}

function normalizeSessionTabs(
  tabs: ReadonlyArray<MobileBrowserSessionTab>,
): ReadonlyArray<MobileBrowserSessionTab> {
  const deduped = new Map<string, MobileBrowserSessionTab>();
  for (const tab of tabs) {
    deduped.set(tab.id, tab);
  }
  return [...deduped.values()].slice(-MAX_MOBILE_BROWSER_TABS);
}

export function mergeMobileBrowserSessionState(
  persisted: unknown,
  current: MobileBrowserSessionState,
): MobileBrowserSessionState {
  if (typeof persisted !== "object" || persisted === null) {
    return current;
  }
  const parsed = persisted as {
    activeTabId?: unknown;
    tabs?: unknown;
  };
  const tabs = Array.isArray(parsed.tabs)
    ? normalizeSessionTabs(parsed.tabs.filter(isSessionTab))
    : current.tabs;
  const activeTabId =
    typeof parsed.activeTabId === "string" && tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : (tabs[0]?.id ?? current.activeTabId);
  return {
    ...current,
    activeTabId,
    tabs,
  };
}

export const useMobileBrowserSessionStore = create<MobileBrowserSessionState>()(
  persist(
    (set) => ({
      activeTabId: null,
      tabs: [],
      clearSession: () => set({ activeTabId: null, tabs: [] }),
      setSession: (tabs, activeTabId) => {
        const normalizedTabs = normalizeSessionTabs(tabs);
        set({
          activeTabId:
            activeTabId && normalizedTabs.some((tab) => tab.id === activeTabId)
              ? activeTabId
              : (normalizedTabs[0]?.id ?? null),
          tabs: normalizedTabs,
        });
      },
    }),
    {
      name: MOBILE_BROWSER_SESSION_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      merge: mergeMobileBrowserSessionState,
      partialize: (state) => ({
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }),
    },
  ),
);
