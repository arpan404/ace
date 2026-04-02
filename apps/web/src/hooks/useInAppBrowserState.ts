import type { ContextMenuItem } from "@t3tools/contracts";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import {
  BROWSER_HISTORY_STORAGE_KEY,
  BrowserHistorySchema,
  buildBrowserSuggestions,
  type BrowserSuggestion,
  recordBrowserHistory,
} from "~/lib/browser/history";
import {
  BROWSER_PINNED_PAGES_STORAGE_KEY,
  BrowserPinnedPagesSchema,
  addPinnedBrowserPage,
  isPinnedBrowserPage,
  parsePinnedBrowserPages,
  removePinnedBrowserPage,
  serializePinnedBrowserPages,
} from "~/lib/browser/pinnedPages";
import {
  BROWSER_SESSION_STORAGE_KEY,
  BrowserSessionStorageSchema,
  addBrowserTab,
  closeBrowserTab,
  createBrowserSettingsTab,
  createBrowserSessionState,
  isBrowserSettingsTabUrl,
  normalizeBrowserSessionState,
  resolveLegacyBrowserUrl,
  setActiveBrowserTab,
  updateBrowserTab,
} from "~/lib/browser/session";
import {
  type BrowserPipBounds,
  clampPipBounds,
  createDefaultPipBounds,
  isBrowserModifierPressed,
  resolveViewportHeight,
  resolveViewportRect,
} from "~/lib/browser/shell";
import {
  type BrowserTabHandle,
  type BrowserTabRuntimeState,
  type BrowserTabSnapshot,
  type BrowserWebviewContextMenuAction,
  DEFAULT_BROWSER_TAB_RUNTIME_STATE,
} from "~/lib/browser/types";
import { normalizeBrowserInput, resolveBrowserHomeUrl } from "~/lib/browser/url";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export interface InAppBrowserController {
  closeActiveTab: () => void;
  closeDevTools: () => void;
  focusAddressBar: () => void;
  goBack: () => void;
  goForward: () => void;
  goToNextTab: () => void;
  goToPreviousTab: () => void;
  openNewTab: () => void;
  openDevTools: () => void;
  openUrl: (rawUrl: string, options?: { newTab?: boolean }) => void;
  reload: () => void;
  setActiveTabByIndex: (index: number) => void;
  toggleDevTools: () => void;
}

export type ActiveBrowserRuntimeState = {
  devToolsOpen: boolean;
  loading: boolean;
};

export type InAppBrowserMode = "full" | "pip" | "split";

interface UseInAppBrowserStateOptions {
  mode: InAppBrowserMode;
  open: boolean;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  viewportRef?: RefObject<HTMLDivElement | null>;
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Unable to read file contents."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Unable to read file."));
    });
    reader.readAsText(file);
  });
}

export function useInAppBrowserState(options: UseInAppBrowserStateOptions) {
  const { mode, onActiveRuntimeStateChange, onControllerChange, open, viewportRef } = options;
  const api = readNativeApi();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const browserSearchEngine = settings.browserSearchEngine;
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const browserContextMenuFallbackTimerRef = useRef<number | null>(null);
  const lastNativeBrowserContextMenuAtRef = useRef<number>(-Infinity);
  const webviewHandlesRef = useRef(new Map<string, BrowserTabHandle>());
  const pipBoundsRef = useRef<BrowserPipBounds>(
    createDefaultPipBounds(resolveViewportRect(viewportRef)),
  );
  const pipDragStateRef = useRef<{
    pointerId: number;
    startBounds: BrowserPipBounds;
    startX: number;
    startY: number;
  } | null>(null);
  const pipResizeStateRef = useRef<{
    pointerId: number;
    startBounds: BrowserPipBounds;
    startX: number;
    startY: number;
  } | null>(null);
  const legacyUrl = useMemo(() => resolveLegacyBrowserUrl(), []);
  const [browserSession, setBrowserSession] = useLocalStorage(
    BROWSER_SESSION_STORAGE_KEY,
    createBrowserSessionState(legacyUrl),
    BrowserSessionStorageSchema,
  );
  const [browserHistory, setBrowserHistory] = useLocalStorage(
    BROWSER_HISTORY_STORAGE_KEY,
    [],
    BrowserHistorySchema,
  );
  const [pinnedPages, setPinnedPages] = useLocalStorage(
    BROWSER_PINNED_PAGES_STORAGE_KEY,
    [],
    BrowserPinnedPagesSchema,
  );
  const [draftUrl, setDraftUrl] = useState(legacyUrl);
  const [browserResetKey, setBrowserResetKey] = useState(0);
  const [isRepairingStorage, setIsRepairingStorage] = useState(false);
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [tabRuntimeById, setTabRuntimeById] = useState<Record<string, BrowserTabRuntimeState>>({});
  const [pipBounds, setPipBounds] = useState<BrowserPipBounds>(() =>
    createDefaultPipBounds(resolveViewportRect(viewportRef)),
  );

  const updateBrowserSession = useCallback(
    (updater: (state: typeof browserSession) => typeof browserSession) => {
      setBrowserSession((current) =>
        normalizeBrowserSessionState(updater(current), legacyUrl, resolveViewportHeight()),
      );
    },
    [legacyUrl, setBrowserSession],
  );

  const activeTab =
    browserSession.tabs.find((tab) => tab.id === browserSession.activeTabId) ??
    browserSession.tabs[0];
  const activeTabIsSettings = activeTab ? isBrowserSettingsTabUrl(activeTab.url) : false;
  const activeTabId = activeTab?.id ?? null;
  const activeTabIsPinned = activeTab ? isPinnedBrowserPage(pinnedPages, activeTab.url) : false;
  const activeTabUrl = activeTab?.url ?? "";
  const activeRuntime = activeTab
    ? (tabRuntimeById[activeTab.id] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE)
    : DEFAULT_BROWSER_TAB_RUNTIME_STATE;
  const addressBarSuggestions = useMemo(() => {
    const openTabs = browserSession.tabs.filter((tab) => !isBrowserSettingsTabUrl(tab.url));
    return buildBrowserSuggestions(activeTabIsSettings ? draftUrl : draftUrl || activeTabUrl, {
      ...(activeTabId ? { activeTabId } : {}),
      ...(activeTabUrl ? { activePageUrl: activeTabUrl } : {}),
      history: browserHistory,
      openTabs,
      pinnedPages,
      searchEngine: browserSearchEngine,
    });
  }, [
    activeTabId,
    activeTabIsSettings,
    activeTabUrl,
    browserHistory,
    browserSearchEngine,
    browserSession.tabs,
    draftUrl,
    pinnedPages,
  ]);
  const showAddressBarSuggestions = mode !== "pip" && isAddressBarFocused;

  const focusAddressBar = useCallback(() => {
    if (mode === "pip") {
      return;
    }
    window.requestAnimationFrame(() => {
      const input = addressInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.select();
    });
  }, [mode]);

  const setActiveTabByIndex = useCallback(
    (index: number) => {
      const nextTab = browserSession.tabs[index];
      if (!nextTab) {
        return;
      }
      updateBrowserSession((current) => setActiveBrowserTab(current, nextTab.id));
      setSelectedSuggestionIndex(0);
    },
    [browserSession.tabs, updateBrowserSession],
  );

  const moveTabSelection = useCallback(
    (direction: -1 | 1) => {
      if (!activeTab || browserSession.tabs.length <= 1) {
        return;
      }
      const currentIndex = browserSession.tabs.findIndex((tab) => tab.id === activeTab.id);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        (currentIndex + direction + browserSession.tabs.length) % browserSession.tabs.length;
      setActiveTabByIndex(nextIndex);
    },
    [activeTab, browserSession.tabs, setActiveTabByIndex],
  );

  const openNewTab = useCallback(() => {
    updateBrowserSession((current) =>
      addBrowserTab(current, {
        activate: true,
        url: resolveBrowserHomeUrl(browserSearchEngine),
      }),
    );
    focusAddressBar();
  }, [browserSearchEngine, focusAddressBar, updateBrowserSession]);

  const openBrowserSettingsTab = useCallback(() => {
    const existing = browserSession.tabs.find((tab) => isBrowserSettingsTabUrl(tab.url));
    if (existing) {
      updateBrowserSession((current) => setActiveBrowserTab(current, existing.id));
      return;
    }
    updateBrowserSession((current) => ({
      ...current,
      activeTabId: "browser-settings",
      tabs: [...current.tabs, createBrowserSettingsTab("browser-settings")],
    }));
  }, [browserSession.tabs, updateBrowserSession]);

  const activateTab = useCallback(
    (tabId: string) => {
      updateBrowserSession((current) => setActiveBrowserTab(current, tabId));
    },
    [updateBrowserSession],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      updateBrowserSession((current) => closeBrowserTab(current, tabId, legacyUrl));
    },
    [legacyUrl, updateBrowserSession],
  );

  const closeActiveTab = useCallback(() => {
    if (!activeTab) {
      return;
    }
    closeTab(activeTab.id);
    focusAddressBar();
  }, [activeTab, closeTab, focusAddressBar]);

  const openUrl = useCallback(
    (rawUrl: string, options?: { newTab?: boolean }) => {
      const nextUrl = normalizeBrowserInput(rawUrl, browserSearchEngine);
      if (!activeTab || options?.newTab || activeTabIsSettings) {
        updateBrowserSession((current) => addBrowserTab(current, { activate: true, url: nextUrl }));
        if (rawUrl.trim().length === 0) {
          focusAddressBar();
        }
        return;
      }
      updateBrowserSession((current) => updateBrowserTab(current, activeTab.id, { url: nextUrl }));
      webviewHandlesRef.current.get(activeTab.id)?.navigate(nextUrl);
    },
    [activeTab, activeTabIsSettings, browserSearchEngine, focusAddressBar, updateBrowserSession],
  );

  const applySuggestion = useCallback(
    (suggestion: BrowserSuggestion) => {
      if (suggestion.kind === "tab" && suggestion.tabId) {
        updateBrowserSession((current) =>
          setActiveBrowserTab(current, suggestion.tabId ?? current.activeTabId),
        );
        setIsAddressBarFocused(false);
        setSelectedSuggestionIndex(0);
        return;
      }
      setDraftUrl(suggestion.title);
      openUrl(suggestion.url, { newTab: activeTabIsSettings });
      setIsAddressBarFocused(false);
      setSelectedSuggestionIndex(0);
    },
    [activeTabIsSettings, openUrl, updateBrowserSession],
  );

  const copyBrowserAddress = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({
        type: "success",
        title: "Copied page address.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Unable to copy page address.",
      });
    }
  }, []);

  const showBrowserContextMenuFallback = useCallback(
    async (tabId: string, position: { x: number; y: number }) => {
      const tab = browserSession.tabs.find((item) => item.id === tabId);
      if (!tab || isBrowserSettingsTabUrl(tab.url)) {
        return;
      }

      const runtime = tabRuntimeById[tabId] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE;
      const items: ContextMenuItem<BrowserWebviewContextMenuAction>[] = [
        {
          disabled: !runtime.canGoBack,
          id: "back",
          label: "Back",
        },
        {
          disabled: !runtime.canGoForward,
          id: "forward",
          label: "Forward",
        },
        {
          id: "reload",
          label: runtime.loading ? "Stop loading" : "Reload page",
        },
        {
          id: "new-tab",
          label: "Open New Tab",
        },
        {
          id: "open-external",
          label: "Open Page Externally",
        },
        {
          id: "copy-address",
          label: "Copy Page Address",
        },
        {
          id: "devtools",
          label: runtime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools",
        },
      ];

      const clicked = await api?.contextMenu.show(items, position);
      const handle = webviewHandlesRef.current.get(tabId);
      switch (clicked) {
        case "back":
          handle?.goBack();
          return;
        case "forward":
          handle?.goForward();
          return;
        case "reload":
          if (runtime.loading) {
            handle?.stop();
          } else {
            handle?.reload();
          }
          return;
        case "new-tab":
          openNewTab();
          return;
        case "open-external":
          await api?.shell.openExternal(tab.url);
          return;
        case "copy-address":
          await copyBrowserAddress(tab.url);
          return;
        case "devtools":
          if (handle?.isDevToolsOpen()) {
            handle.closeDevTools();
          } else {
            handle?.openDevTools();
          }
          return;
        default:
      }
    },
    [api, browserSession.tabs, copyBrowserAddress, openNewTab, tabRuntimeById],
  );

  const handleWebviewContextMenuFallbackRequest = useCallback(
    (tabId: string, position: { x: number; y: number }, requestedAt: number) => {
      if (browserContextMenuFallbackTimerRef.current !== null) {
        window.clearTimeout(browserContextMenuFallbackTimerRef.current);
      }

      browserContextMenuFallbackTimerRef.current = window.setTimeout(() => {
        browserContextMenuFallbackTimerRef.current = null;
        if (lastNativeBrowserContextMenuAtRef.current >= requestedAt - 8) {
          return;
        }
        void showBrowserContextMenuFallback(tabId, position);
      }, 120);
    },
    [showBrowserContextMenuFallback],
  );

  const clearHistory = useCallback(() => {
    setBrowserHistory([]);
    toastManager.add({
      type: "success",
      title: "Browser history cleared.",
    });
  }, [setBrowserHistory]);

  const togglePinnedActivePage = useCallback(() => {
    if (!activeTab || activeTabIsSettings) {
      return;
    }

    setPinnedPages((current) =>
      isPinnedBrowserPage(current, activeTab.url)
        ? removePinnedBrowserPage(current, activeTab.url)
        : addPinnedBrowserPage(current, {
            pinnedAt: Date.now(),
            title: activeTab.title,
            url: activeTab.url,
          }),
    );
    toastManager.add({
      type: "success",
      title: activeTabIsPinned ? "Pinned page removed." : "Page pinned.",
    });
  }, [activeTab, activeTabIsPinned, activeTabIsSettings, setPinnedPages]);

  const removePinnedPage = useCallback(
    (url: string) => {
      setPinnedPages((current) => removePinnedBrowserPage(current, url));
      toastManager.add({
        type: "success",
        title: "Pinned page removed.",
      });
    },
    [setPinnedPages],
  );

  const openPinnedPage = useCallback(
    (url: string) => {
      openUrl(url, { newTab: true });
    },
    [openUrl],
  );

  const exportPinnedPages = useCallback(() => {
    try {
      const contents = serializePinnedBrowserPages(pinnedPages);
      const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = "t3-browser-pinned-pages.json";
      anchor.click();
      URL.revokeObjectURL(downloadUrl);
      toastManager.add({
        type: "success",
        title: "Pinned pages exported.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Unable to export pinned pages.",
      });
    }
  }, [pinnedPages]);

  const importPinnedPages = useCallback(
    async (file: File) => {
      try {
        const contents = await readTextFile(file);
        const importedPages = parsePinnedBrowserPages(contents);
        setPinnedPages((current) => {
          let nextPages = current;
          for (const page of importedPages) {
            nextPages = addPinnedBrowserPage(nextPages, page);
          }
          return nextPages;
        });
        toastManager.add({
          type: "success",
          title:
            importedPages.length === 1
              ? "Imported 1 pinned page."
              : `Imported ${importedPages.length} pinned pages.`,
        });
      } catch {
        toastManager.add({
          type: "error",
          title: "Unable to import pinned pages.",
        });
      }
    },
    [setPinnedPages],
  );

  const goBack = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.goBack();
  }, [activeTab]);

  const goForward = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.goForward();
  }, [activeTab]);

  const reload = useCallback(() => {
    if (!activeTab) return;
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (activeRuntime.loading) {
      handle?.stop();
      return;
    }
    handle?.reload();
  }, [activeRuntime.loading, activeTab]);

  const openDevTools = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.openDevTools();
  }, [activeTab]);

  const closeDevTools = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.closeDevTools();
  }, [activeTab]);

  const toggleDevTools = useCallback(() => {
    if (!activeTab) return;
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (!handle) return;
    if (handle.isDevToolsOpen()) {
      handle.closeDevTools();
      return;
    }
    handle.openDevTools();
  }, [activeTab]);

  const repairBrowserStorage = useCallback(async () => {
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Browser repair is unavailable.",
      });
      return;
    }

    const confirmed = await api.dialogs.confirm(
      "Repair browser storage? This clears cookies, site data, cache, and service workers for the in-app browser, then reloads its tabs.",
    );
    if (!confirmed) {
      return;
    }

    setIsRepairingStorage(true);
    try {
      const repaired = await api.browser.repairStorage();
      if (!repaired) {
        toastManager.add({
          type: "error",
          title: "Browser storage repair failed.",
          description: "The in-app browser partition could not be repaired.",
        });
        return;
      }

      webviewHandlesRef.current.clear();
      setTabRuntimeById({});
      setBrowserResetKey((current) => current + 1);
      toastManager.add({
        type: "success",
        title: "Browser storage repaired.",
        description: "In-app browser tabs were reloaded with a fresh storage partition.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Browser storage repair failed.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsRepairingStorage(false);
    }
  }, [api]);

  const openActiveTabExternally = useCallback(() => {
    if (!activeTab || activeTabIsSettings) {
      return;
    }
    void api?.shell.openExternal(activeTab.url);
  }, [activeTab, activeTabIsSettings, api]);

  const handleAddressBarKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (!showAddressBarSuggestions || addressBarSuggestions.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((current) =>
          Math.min(current + 1, addressBarSuggestions.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        const suggestion = addressBarSuggestions[selectedSuggestionIndex];
        if (suggestion) {
          event.preventDefault();
          applySuggestion(suggestion);
        }
        return;
      }
      if (event.key === "Escape") {
        setIsAddressBarFocused(false);
      }
    },
    [addressBarSuggestions, applySuggestion, selectedSuggestionIndex, showAddressBarSuggestions],
  );

  const handleBrowserKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!isBrowserModifierPressed(event)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (key === "[") {
          event.preventDefault();
          event.stopPropagation();
          moveTabSelection(-1);
        } else if (key === "]") {
          event.preventDefault();
          event.stopPropagation();
          moveTabSelection(1);
        } else if (key === "i") {
          event.preventDefault();
          event.stopPropagation();
          toggleDevTools();
        }
        return;
      }

      if (key === "n") {
        event.preventDefault();
        event.stopPropagation();
        openNewTab();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        event.stopPropagation();
        closeActiveTab();
        return;
      }
      if (key === "l") {
        event.preventDefault();
        event.stopPropagation();
        focusAddressBar();
        return;
      }
      if (key === "[") {
        event.preventDefault();
        event.stopPropagation();
        goBack();
        return;
      }
      if (key === "]") {
        event.preventDefault();
        event.stopPropagation();
        goForward();
        return;
      }
      if (key === "r") {
        event.preventDefault();
        event.stopPropagation();
        reload();
        return;
      }

      const index = Number.parseInt(key, 10);
      if (Number.isInteger(index) && index >= 1 && index <= 9) {
        event.preventDefault();
        event.stopPropagation();
        setActiveTabByIndex(index - 1);
      }
    },
    [
      closeActiveTab,
      focusAddressBar,
      goBack,
      goForward,
      moveTabSelection,
      openNewTab,
      reload,
      setActiveTabByIndex,
      toggleDevTools,
    ],
  );

  const registerWebviewHandle = useCallback((tabId: string, handle: BrowserTabHandle | null) => {
    if (handle) {
      webviewHandlesRef.current.set(tabId, handle);
      return;
    }
    webviewHandlesRef.current.delete(tabId);
  }, []);

  const handleTabSnapshotChange = useCallback(
    (tabId: string, snapshot: BrowserTabSnapshot) => {
      setTabRuntimeById((current) => {
        const previous = current[tabId];
        if (
          previous?.canGoBack === snapshot.canGoBack &&
          previous?.canGoForward === snapshot.canGoForward &&
          previous?.devToolsOpen === snapshot.devToolsOpen &&
          previous?.loading === snapshot.loading
        ) {
          return current;
        }
        return {
          ...current,
          [tabId]: {
            canGoBack: snapshot.canGoBack,
            canGoForward: snapshot.canGoForward,
            devToolsOpen: snapshot.devToolsOpen,
            loading: snapshot.loading,
          },
        };
      });
      updateBrowserSession((current) => updateBrowserTab(current, tabId, snapshot));
      if (!isBrowserSettingsTabUrl(snapshot.url)) {
        setBrowserHistory((current) =>
          recordBrowserHistory(current, {
            title: snapshot.title,
            url: snapshot.url,
            visitCount: 0,
            visitedAt: Date.now(),
          }),
        );
      }
    },
    [setBrowserHistory, updateBrowserSession],
  );

  const syncPipBounds = useCallback(
    (nextBounds: BrowserPipBounds) => {
      const clamped = clampPipBounds(nextBounds, resolveViewportRect(viewportRef));
      pipBoundsRef.current = clamped;
      setPipBounds(clamped);
    },
    [viewportRef],
  );

  const handlePipDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mode !== "pip" || event.button !== 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("button, input, form, [data-browser-control]")) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pipDragStateRef.current = {
        pointerId: event.pointerId,
        startBounds: pipBoundsRef.current,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [mode],
  );

  const handlePipDragPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = pipDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      syncPipBounds({
        ...dragState.startBounds,
        x: dragState.startBounds.x + (event.clientX - dragState.startX),
        y: dragState.startBounds.y + (event.clientY - dragState.startY),
      });
    },
    [syncPipBounds],
  );

  const handlePipDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = pipDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    pipDragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePipResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mode !== "pip" || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      pipResizeStateRef.current = {
        pointerId: event.pointerId,
        startBounds: pipBoundsRef.current,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [mode],
  );

  const handlePipResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = pipResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      syncPipBounds({
        ...resizeState.startBounds,
        width: resizeState.startBounds.width + (event.clientX - resizeState.startX),
        height: resizeState.startBounds.height + (event.clientY - resizeState.startY),
      });
    },
    [syncPipBounds],
  );

  const handlePipResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = pipResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    pipResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const browserShellStyle = useMemo<CSSProperties | undefined>(() => {
    if (mode === "full") {
      return {
        height: "100%",
        left: 0,
        top: 0,
        width: "100%",
      };
    }
    if (mode === "split") {
      return undefined;
    }
    return {
      height: `${pipBounds.height}px`,
      left: `${pipBounds.x}px`,
      top: `${pipBounds.y}px`,
      width: `${pipBounds.width}px`,
    };
  }, [mode, pipBounds.height, pipBounds.width, pipBounds.x, pipBounds.y]);

  const browserStatusLabel = activeRuntime.devToolsOpen
    ? activeRuntime.loading
      ? "Inspecting · Loading"
      : "Inspecting"
    : activeRuntime.loading
      ? "Loading"
      : null;

  useEffect(() => {
    setDraftUrl(activeTabIsSettings ? "" : activeTabUrl);
  }, [activeTabIsSettings, activeTabUrl]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [draftUrl, addressBarSuggestions.length]);

  useEffect(() => {
    onActiveRuntimeStateChange?.({
      devToolsOpen: activeRuntime.devToolsOpen,
      loading: activeRuntime.loading,
    });
  }, [activeRuntime.devToolsOpen, activeRuntime.loading, onActiveRuntimeStateChange]);

  useEffect(() => {
    if (!open || mode === "pip") {
      return;
    }
    focusAddressBar();
  }, [focusAddressBar, mode, open]);

  useEffect(() => {
    if (!window.desktopBridge?.onBrowserShortcutAction) {
      return;
    }
    return window.desktopBridge.onBrowserShortcutAction((action) => {
      if (!open) {
        return;
      }
      switch (action) {
        case "back":
          goBack();
          return;
        case "close-tab":
          closeActiveTab();
          return;
        case "devtools":
          toggleDevTools();
          return;
        case "focus-address-bar":
          focusAddressBar();
          return;
        case "forward":
          goForward();
          return;
        case "new-tab":
          openNewTab();
          return;
        case "next-tab":
          moveTabSelection(1);
          return;
        case "previous-tab":
          moveTabSelection(-1);
          return;
        case "reload":
          reload();
          return;
        default:
          if (action.startsWith("select-tab-")) {
            const index = Number.parseInt(action.slice("select-tab-".length), 10);
            if (Number.isInteger(index) && index >= 1) {
              setActiveTabByIndex(index - 1);
            }
          }
      }
    });
  }, [
    closeActiveTab,
    focusAddressBar,
    goBack,
    goForward,
    moveTabSelection,
    open,
    openNewTab,
    reload,
    setActiveTabByIndex,
    toggleDevTools,
  ]);

  useEffect(() => {
    if (!window.desktopBridge?.onBrowserContextMenuShown) {
      return;
    }
    return window.desktopBridge.onBrowserContextMenuShown(() => {
      lastNativeBrowserContextMenuAtRef.current = performance.now();
      if (browserContextMenuFallbackTimerRef.current !== null) {
        window.clearTimeout(browserContextMenuFallbackTimerRef.current);
        browserContextMenuFallbackTimerRef.current = null;
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (browserContextMenuFallbackTimerRef.current !== null) {
        window.clearTimeout(browserContextMenuFallbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    pipBoundsRef.current = pipBounds;
  }, [pipBounds]);

  useEffect(() => {
    const syncBounds = () => {
      const viewportRect = resolveViewportRect(viewportRef);
      setPipBounds((current) => clampPipBounds(current, viewportRect));
    };

    syncBounds();
    window.addEventListener("resize", syncBounds);
    const viewport = viewportRef?.current;
    const observer =
      viewport && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncBounds();
          })
        : null;
    if (observer && viewport) {
      observer.observe(viewport);
    }

    return () => {
      window.removeEventListener("resize", syncBounds);
      observer?.disconnect();
    };
  }, [viewportRef]);

  useEffect(() => {
    setTabRuntimeById((current) => {
      const validIds = new Set(browserSession.tabs.map((tab) => tab.id));
      const entries = Object.entries(current).filter(([tabId]) => validIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [browserSession.tabs]);

  useEffect(() => {
    const controller: InAppBrowserController = {
      closeActiveTab,
      closeDevTools,
      focusAddressBar,
      goBack,
      goForward,
      goToNextTab: () => moveTabSelection(1),
      goToPreviousTab: () => moveTabSelection(-1),
      openNewTab,
      openDevTools,
      openUrl,
      reload,
      setActiveTabByIndex,
      toggleDevTools,
    };
    onControllerChange?.(controller);
    return () => {
      onControllerChange?.(null);
    };
  }, [
    closeActiveTab,
    closeDevTools,
    focusAddressBar,
    goBack,
    goForward,
    moveTabSelection,
    onControllerChange,
    openNewTab,
    openDevTools,
    openUrl,
    reload,
    setActiveTabByIndex,
    toggleDevTools,
  ]);

  return {
    activateTab,
    activeRuntime,
    activeTab,
    activeTabIsPinned,
    activeTabIsSettings,
    addressBarSuggestions,
    addressInputRef,
    applySuggestion,
    browserHistoryCount: browserHistory.length,
    browserResetKey,
    browserSearchEngine,
    browserSession,
    browserShellStyle,
    browserStatusLabel,
    clearHistory,
    closeActiveTab,
    closeDevTools,
    closeTab,
    draftUrl,
    exportPinnedPages,
    focusAddressBar,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
    handlePipDragPointerDown,
    handlePipDragPointerEnd,
    handlePipDragPointerMove,
    handlePipResizePointerDown,
    handlePipResizePointerEnd,
    handlePipResizePointerMove,
    handleTabSnapshotChange,
    handleWebviewContextMenuFallbackRequest,
    importPinnedPages,
    isAddressBarFocused,
    isRepairingStorage,
    openActiveTabExternally,
    openBrowserSettingsTab,
    openDevTools,
    openNewTab,
    openPinnedPage,
    openUrl,
    pinnedPages,
    registerWebviewHandle,
    reload,
    removePinnedPage,
    repairBrowserStorage,
    selectSearchEngine: (engine: typeof browserSearchEngine) => {
      updateSettings({ browserSearchEngine: engine });
    },
    selectedSuggestionIndex,
    setDraftUrl,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    setActiveTabByIndex,
    showAddressBarSuggestions,
    toggleDevTools,
    togglePinnedActivePage,
  };
}
