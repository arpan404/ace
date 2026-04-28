import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useDeferredValue,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSetting, useUpdateSettings } from "~/hooks/useSettings";
import {
  BROWSER_HISTORY_STORAGE_KEY,
  BrowserHistorySchema,
  buildBrowserSuggestions,
  type BrowserSuggestion,
  recordBrowserHistory,
} from "~/lib/browser/history";
import {
  type BrowserDesignerPillPosition,
  type BrowserDesignerTool,
  BrowserDesignerStateSchema,
  createBrowserDesignerState,
  resolveBrowserDesignerStateStorageKey,
} from "~/lib/browser/designer";
import {
  BROWSER_NEW_TAB_URL,
  BrowserSessionStorageSchema,
  addBrowserTab,
  closeBrowserTab,
  createBrowserSessionState,
  isBrowserInternalTabUrl,
  isBrowserNewTabUrl,
  normalizeBrowserSessionState,
  reorderBrowserTab,
  resolveBrowserSessionStorageKey,
  setActiveBrowserTab,
  updateBrowserTab,
} from "~/lib/browser/session";
import {
  type BrowserTabHandle,
  type BrowserTabRuntimeState,
  type BrowserTabSnapshot,
  type BrowserTabSnapshotOptions,
  DEFAULT_BROWSER_TAB_RUNTIME_STATE,
} from "~/lib/browser/types";
import { normalizeBrowserInput } from "~/lib/browser/url";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export interface InAppBrowserController {
  closeActiveTab: () => void;
  closeTab: (tabId: string) => void;
  closeDevTools: () => void;
  focusAddressBar: () => void;
  goBack: () => void;
  goForward: () => void;
  goToNextTab: () => void;
  goToPreviousTab: () => void;
  openNewTab: () => void;
  openDevTools: () => void;
  openUrl: (rawUrl: string, options?: { newTab?: boolean }) => void;
  reorderTabs: (draggedTabId: string, targetTabId: string) => void;
  reload: () => void;
  setActiveTabByIndex: (index: number) => void;
  toggleDesignerTool: (tool: BrowserDesignerTool) => void;
  toggleDevTools: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
}

export type ActiveBrowserRuntimeState = {
  devToolsOpen: boolean;
  loading: boolean;
};

function resolveViewportHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 900;
}

export type InAppBrowserMode = "full" | "split";

interface UseInAppBrowserStateOptions {
  designerModeEnabled?: boolean;
  mode: InAppBrowserMode;
  open: boolean;
  scopeId?: string;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  onClose?: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
}

const EMPTY_BROWSER_SUGGESTIONS: BrowserSuggestion[] = [];

export function shouldAutoFocusBrowserAddressBarOnOpen(options: {
  activeTabIsNewTab: boolean;
  browserTabCount: number;
}): boolean {
  return options.activeTabIsNewTab && options.browserTabCount === 1;
}

export function resolveBrowserSuggestionDraftValue(suggestion: BrowserSuggestion): string {
  return suggestion.kind === "search" ? suggestion.title : suggestion.url;
}

export function resolveNextBrowserSuggestionIndex(
  currentIndex: number,
  suggestionCount: number,
  direction: -1 | 1,
): number {
  if (suggestionCount <= 0) {
    return -1;
  }
  if (currentIndex < 0) {
    return direction > 0 ? 0 : suggestionCount - 1;
  }
  return Math.max(0, Math.min(currentIndex + direction, suggestionCount - 1));
}

export function shouldShowBrowserAddressBarSuggestions(options: {
  isAddressBarFocused: boolean;
  suggestionsDismissed: boolean;
}): boolean {
  return options.isAddressBarFocused && !options.suggestionsDismissed;
}

export function useInAppBrowserState(options: UseInAppBrowserStateOptions) {
  const {
    designerModeEnabled = true,
    mode,
    onActiveRuntimeStateChange,
    onClose,
    onControllerChange,
    open,
    scopeId,
  } = options;
  const api = readNativeApi();
  const { updateSettings } = useUpdateSettings();
  const browserSearchEngine = useSetting("browserSearchEngine");
  const browserSessionStorageKey = resolveBrowserSessionStorageKey(scopeId);
  const browserDesignerStorageKey = resolveBrowserDesignerStateStorageKey(scopeId);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const initialAddressBarAutoFocusHandledRef = useRef(false);
  const browserContextMenuFallbackTimerRef = useRef<number | null>(null);
  const lastNativeBrowserContextMenuAtRef = useRef<number>(-Infinity);
  const webviewHandlesRef = useRef(new Map<string, BrowserTabHandle>());
  const lastRecordedBrowserHistoryUrlByTabRef = useRef(new Map<string, string>());
  const [browserSession, setBrowserSession] = useLocalStorage(
    browserSessionStorageKey,
    createBrowserSessionState(),
    BrowserSessionStorageSchema,
  );
  const [designerState, setDesignerState] = useLocalStorage(
    browserDesignerStorageKey,
    createBrowserDesignerState(),
    BrowserDesignerStateSchema,
  );
  const [browserHistory, setBrowserHistory] = useLocalStorage(
    BROWSER_HISTORY_STORAGE_KEY,
    [],
    BrowserHistorySchema,
  );
  const [draftUrl, setDraftUrl] = useState("");
  const [browserResetKey, setBrowserResetKey] = useState(0);
  const [isRepairingStorage, setIsRepairingStorage] = useState(false);
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [addressBarSuggestionsDismissed, setAddressBarSuggestionsDismissed] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [tabRuntimeById, setTabRuntimeById] = useState<Record<string, BrowserTabRuntimeState>>({});
  const updateBrowserSession = useCallback(
    (updater: (state: typeof browserSession) => typeof browserSession) => {
      setBrowserSession((current) =>
        normalizeBrowserSessionState(
          updater(current),
          BROWSER_NEW_TAB_URL,
          resolveViewportHeight(),
        ),
      );
    },
    [setBrowserSession],
  );

  const activeTab =
    browserSession.tabs.find((tab) => tab.id === browserSession.activeTabId) ??
    browserSession.tabs[0];
  const activeTabIsInternal = activeTab ? isBrowserInternalTabUrl(activeTab.url) : false;
  const activeTabIsNewTab = activeTab ? isBrowserNewTabUrl(activeTab.url) : false;
  const activeTabId = activeTab?.id ?? null;
  const activeTabUrl = activeTab?.url ?? "";
  const activeRuntime = activeTab
    ? (tabRuntimeById[activeTab.id] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE)
    : DEFAULT_BROWSER_TAB_RUNTIME_STATE;
  const showAddressBarSuggestions = shouldShowBrowserAddressBarSuggestions({
    isAddressBarFocused,
    suggestionsDismissed: addressBarSuggestionsDismissed,
  });
  const suggestionInput = activeTabIsInternal ? draftUrl : draftUrl || activeTabUrl;
  const deferredSuggestionInput = useDeferredValue(suggestionInput);
  const openTabs = useMemo(
    () => browserSession.tabs.filter((tab) => !isBrowserInternalTabUrl(tab.url)),
    [browserSession.tabs],
  );
  const addressBarSuggestions = useMemo(() => {
    if (!showAddressBarSuggestions) {
      return EMPTY_BROWSER_SUGGESTIONS;
    }

    return buildBrowserSuggestions(deferredSuggestionInput, {
      ...(activeTabId ? { activeTabId } : {}),
      ...(activeTabUrl ? { activePageUrl: activeTabUrl } : {}),
      history: browserHistory,
      openTabs,
      searchEngine: browserSearchEngine,
    });
  }, [
    activeTabId,
    activeTabUrl,
    browserHistory,
    browserSearchEngine,
    deferredSuggestionInput,
    openTabs,
    showAddressBarSuggestions,
  ]);

  const focusAddressBar = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = addressInputRef.current;
      if (!input) {
        return;
      }
      setAddressBarSuggestionsDismissed(false);
      input.focus();
      input.select();
    });
  }, []);
  const showAddressBarSuggestionOverlay = useCallback(() => {
    setAddressBarSuggestionsDismissed(false);
  }, []);

  const setActiveTabByIndex = useCallback(
    (index: number) => {
      const nextTab = browserSession.tabs[index];
      if (!nextTab) {
        return;
      }
      updateBrowserSession((current) => setActiveBrowserTab(current, nextTab.id));
      setSelectedSuggestionIndex(-1);
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
        url: BROWSER_NEW_TAB_URL,
      }),
    );
    focusAddressBar();
  }, [focusAddressBar, updateBrowserSession]);

  const activateTab = useCallback(
    (tabId: string) => {
      updateBrowserSession((current) => setActiveBrowserTab(current, tabId));
    },
    [updateBrowserSession],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      if (browserSession.tabs.length <= 1 && browserSession.tabs.some((tab) => tab.id === tabId)) {
        onClose?.();
        return;
      }
      updateBrowserSession((current) => closeBrowserTab(current, tabId, BROWSER_NEW_TAB_URL));
    },
    [browserSession.tabs, onClose, updateBrowserSession],
  );

  const reorderTabs = useCallback(
    (draggedTabId: string, targetTabId: string) => {
      updateBrowserSession((current) => reorderBrowserTab(current, draggedTabId, targetTabId));
    },
    [updateBrowserSession],
  );

  const closeActiveTab = useCallback(() => {
    if (!activeTab) {
      return;
    }
    if (browserSession.tabs.length <= 1) {
      onClose?.();
      return;
    }
    closeTab(activeTab.id);
  }, [activeTab, browserSession.tabs.length, closeTab, onClose]);

  const zoomIn = useCallback(() => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    webviewHandlesRef.current.get(activeTab.id)?.zoomIn();
  }, [activeTab, activeTabIsInternal]);

  const zoomOut = useCallback(() => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    webviewHandlesRef.current.get(activeTab.id)?.zoomOut();
  }, [activeTab, activeTabIsInternal]);

  const zoomReset = useCallback(() => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    webviewHandlesRef.current.get(activeTab.id)?.zoomReset();
  }, [activeTab, activeTabIsInternal]);

  const openUrl = useCallback(
    (rawUrl: string, options?: { newTab?: boolean }) => {
      const nextUrl = normalizeBrowserInput(rawUrl, browserSearchEngine);
      if (!activeTab || options?.newTab) {
        updateBrowserSession((current) => addBrowserTab(current, { activate: true, url: nextUrl }));
        if (rawUrl.trim().length === 0) {
          focusAddressBar();
        }
        return;
      }
      updateBrowserSession((current) => updateBrowserTab(current, activeTab.id, { url: nextUrl }));
      if (activeTabIsInternal) {
        return;
      }
      webviewHandlesRef.current.get(activeTab.id)?.navigate(nextUrl);
    },
    [activeTab, activeTabIsInternal, browserSearchEngine, focusAddressBar, updateBrowserSession],
  );

  const applySuggestion = useCallback(
    (suggestion: BrowserSuggestion) => {
      if (suggestion.kind === "tab" && suggestion.tabId) {
        updateBrowserSession((current) =>
          setActiveBrowserTab(current, suggestion.tabId ?? current.activeTabId),
        );
        setAddressBarSuggestionsDismissed(false);
        setIsAddressBarFocused(false);
        setSelectedSuggestionIndex(-1);
        return;
      }
      setDraftUrl(resolveBrowserSuggestionDraftValue(suggestion));
      openUrl(suggestion.url);
      setAddressBarSuggestionsDismissed(false);
      setIsAddressBarFocused(false);
      setSelectedSuggestionIndex(-1);
    },
    [openUrl, updateBrowserSession],
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
      if (!tab) {
        return;
      }

      const runtime = tabRuntimeById[tabId] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE;
      const items = [
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

  const selectDesignerTool = useCallback(
    (tool: BrowserDesignerTool) => {
      setDesignerState((current) =>
        current.tool === tool && current.active === (tool !== "cursor")
          ? current
          : {
              ...current,
              active: tool !== "cursor",
              tool,
            },
      );
    },
    [setDesignerState],
  );
  const setDesignerModeActive = useCallback(
    (active: boolean) => {
      setDesignerState((current) =>
        current.active === active &&
        (active || current.tool === "cursor") &&
        (!active || current.tool !== "cursor")
          ? current
          : {
              ...current,
              active,
              tool: active ? (current.tool === "cursor" ? "area-comment" : current.tool) : "cursor",
            },
      );
    },
    [setDesignerState],
  );
  const toggleDesignerTool = useCallback(
    (tool: BrowserDesignerTool) => {
      if (activeTabIsInternal) {
        return;
      }
      setDesignerState((current) => {
        const shouldDeactivate = tool === "cursor" || (current.active && current.tool === tool);
        if (shouldDeactivate) {
          if (!current.active && current.tool === "cursor") {
            return current;
          }
          return {
            ...current,
            active: false,
            tool: "cursor",
          };
        }
        return {
          ...current,
          active: true,
          tool,
        };
      });
    },
    [activeTabIsInternal, setDesignerState],
  );
  const setDesignerPillPosition = useCallback(
    (pillPosition: BrowserDesignerPillPosition | null) => {
      setDesignerState((current) => {
        const currentPosition = current.pillPosition;
        if (currentPosition?.x === pillPosition?.x && currentPosition?.y === pillPosition?.y) {
          return current;
        }
        return {
          ...current,
          pillPosition,
        };
      });
    },
    [setDesignerState],
  );

  const closeActiveTabEvent = useEffectEvent(closeActiveTab);
  const closeTabEvent = useEffectEvent(closeTab);
  const closeDevToolsEvent = useEffectEvent(closeDevTools);
  const focusAddressBarEvent = useEffectEvent(focusAddressBar);
  const goBackEvent = useEffectEvent(goBack);
  const goForwardEvent = useEffectEvent(goForward);
  const moveTabSelectionEvent = useEffectEvent(moveTabSelection);
  const openDevToolsEvent = useEffectEvent(openDevTools);
  const openNewTabEvent = useEffectEvent(openNewTab);
  const reorderTabsEvent = useEffectEvent(reorderTabs);
  const openUrlEvent = useEffectEvent(openUrl);
  const reloadEvent = useEffectEvent(reload);
  const setActiveTabByIndexEvent = useEffectEvent(setActiveTabByIndex);
  const toggleDesignerToolEvent = useEffectEvent(toggleDesignerTool);
  const toggleDevToolsEvent = useEffectEvent(toggleDevTools);
  const zoomInEvent = useEffectEvent(zoomIn);
  const zoomOutEvent = useEffectEvent(zoomOut);
  const zoomResetEvent = useEffectEvent(zoomReset);
  const browserController = useMemo<InAppBrowserController>(
    () => ({
      closeActiveTab: () => closeActiveTabEvent(),
      closeTab: (tabId) => closeTabEvent(tabId),
      closeDevTools: () => closeDevToolsEvent(),
      focusAddressBar: () => focusAddressBarEvent(),
      goBack: () => goBackEvent(),
      goForward: () => goForwardEvent(),
      goToNextTab: () => moveTabSelectionEvent(1),
      goToPreviousTab: () => moveTabSelectionEvent(-1),
      openDevTools: () => openDevToolsEvent(),
      openNewTab: () => openNewTabEvent(),
      openUrl: (rawUrl, options) => openUrlEvent(rawUrl, options),
      reorderTabs: (draggedTabId, targetTabId) => reorderTabsEvent(draggedTabId, targetTabId),
      reload: () => reloadEvent(),
      setActiveTabByIndex: (index) => setActiveTabByIndexEvent(index),
      toggleDesignerTool: (tool) => toggleDesignerToolEvent(tool),
      toggleDevTools: () => toggleDevToolsEvent(),
      zoomIn: () => zoomInEvent(),
      zoomOut: () => zoomOutEvent(),
      zoomReset: () => zoomResetEvent(),
    }),
    [],
  );

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
      lastRecordedBrowserHistoryUrlByTabRef.current.clear();
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
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    void api?.shell.openExternal(activeTab.url);
  }, [activeTab, activeTabIsInternal, api]);

  const handleAddressBarKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setAddressBarSuggestionsDismissed(true);
        setSelectedSuggestionIndex(-1);
        return;
      }
      if (!showAddressBarSuggestions || addressBarSuggestions.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((current) =>
          resolveNextBrowserSuggestionIndex(current, addressBarSuggestions.length, 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((current) =>
          resolveNextBrowserSuggestionIndex(current, addressBarSuggestions.length, -1),
        );
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
    },
    [
      addressBarSuggestions,
      applySuggestion,
      selectedSuggestionIndex,
      setAddressBarSuggestionsDismissed,
      showAddressBarSuggestions,
    ],
  );

  const handleBrowserKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
      const usesMod = isMac ? event.metaKey : event.ctrlKey;
      if (!usesMod) {
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
    lastRecordedBrowserHistoryUrlByTabRef.current.delete(tabId);
  }, []);

  const handleTabSnapshotChange = useCallback(
    (tabId: string, snapshot: BrowserTabSnapshot, options?: BrowserTabSnapshotOptions) => {
      const persistTab = options?.persistTab ?? true;
      const recordHistoryEntry = options?.recordHistory === true;
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
      if (persistTab) {
        updateBrowserSession((current) => updateBrowserTab(current, tabId, snapshot));
      }
      if (isBrowserInternalTabUrl(snapshot.url)) {
        lastRecordedBrowserHistoryUrlByTabRef.current.delete(tabId);
      } else if (
        recordHistoryEntry &&
        lastRecordedBrowserHistoryUrlByTabRef.current.get(tabId) !== snapshot.url
      ) {
        lastRecordedBrowserHistoryUrlByTabRef.current.set(tabId, snapshot.url);
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
  }, [mode]);

  const browserStatusLabel = activeRuntime.devToolsOpen
    ? activeRuntime.loading
      ? "Inspecting · Loading"
      : "Inspecting"
    : activeRuntime.loading
      ? "Loading"
      : null;

  useEffect(() => {
    setDraftUrl(activeTabIsInternal ? "" : activeTabUrl);
    setAddressBarSuggestionsDismissed(false);
  }, [activeTabIsInternal, activeTabUrl]);

  useEffect(() => {
    initialAddressBarAutoFocusHandledRef.current = false;
  }, [browserSessionStorageKey]);

  useEffect(() => {
    setSelectedSuggestionIndex(-1);
  }, [draftUrl, addressBarSuggestions.length]);

  useEffect(() => {
    onActiveRuntimeStateChange?.({
      devToolsOpen: activeRuntime.devToolsOpen,
      loading: activeRuntime.loading,
    });
  }, [activeRuntime.devToolsOpen, activeRuntime.loading, onActiveRuntimeStateChange]);

  useEffect(() => {
    if (!open || initialAddressBarAutoFocusHandledRef.current) {
      return;
    }
    initialAddressBarAutoFocusHandledRef.current = true;
    if (
      !shouldAutoFocusBrowserAddressBarOnOpen({
        activeTabIsNewTab,
        browserTabCount: browserSession.tabs.length,
      })
    ) {
      return;
    }
    focusAddressBar();
  }, [activeTabIsNewTab, browserSession.tabs.length, focusAddressBar, open]);

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
        case "designer-area-comment":
          toggleDesignerTool("area-comment");
          return;
        case "designer-cursor":
          toggleDesignerTool("cursor");
          return;
        case "designer-draw-comment":
          toggleDesignerTool("draw-comment");
          return;
        case "designer-element-comment":
          toggleDesignerTool("element-comment");
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
        case "toggle-designer-mode":
          if (!designerModeEnabled || activeTabIsInternal) {
            return;
          }
          setDesignerModeActive(!designerState.active);
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
    activeTabIsInternal,
    closeActiveTab,
    designerModeEnabled,
    designerState.active,
    focusAddressBar,
    goBack,
    goForward,
    moveTabSelection,
    open,
    openNewTab,
    reload,
    setActiveTabByIndex,
    setDesignerModeActive,
    toggleDesignerTool,
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
    setTabRuntimeById((current) => {
      const validIds = new Set(browserSession.tabs.map((tab) => tab.id));
      const entries = Object.entries(current).filter(([tabId]) => validIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [browserSession.tabs]);

  useEffect(() => {
    if (!activeTabIsInternal || !designerState.active) {
      return;
    }
    setDesignerState((current) =>
      current.active
        ? {
            ...current,
            active: false,
            tool: "cursor",
          }
        : current,
    );
  }, [activeTabIsInternal, designerState.active, setDesignerState]);

  useEffect(() => {
    onControllerChange?.(browserController);
    return () => {
      onControllerChange?.(null);
    };
  }, [browserController, onControllerChange]);

  return {
    activateTab,
    activeRuntime,
    activeTab,
    activeTabIsInternal,
    activeTabIsNewTab,
    addressBarSuggestions,
    addressInputRef,
    applySuggestion,
    browserResetKey,
    browserSearchEngine,
    browserSession,
    browserShellStyle,
    browserStatusLabel,
    closeActiveTab,
    closeDevTools,
    closeTab,
    draftUrl,
    designerState,
    focusAddressBar,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
    handleTabSnapshotChange,
    handleWebviewContextMenuFallbackRequest,
    isAddressBarFocused,
    isRepairingStorage,
    openActiveTabExternally,
    openDevTools,
    openNewTab,
    openUrl,
    reorderTabs,
    registerWebviewHandle,
    reload,
    repairBrowserStorage,
    selectDesignerTool,
    selectSearchEngine: (engine: typeof browserSearchEngine) => {
      updateSettings({ browserSearchEngine: engine });
    },
    setDesignerModeActive,
    setDesignerPillPosition,
    selectedSuggestionIndex,
    setDraftUrl,
    showAddressBarSuggestionOverlay,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    setActiveTabByIndex,
    showAddressBarSuggestions,
    toggleDevTools,
    zoomIn,
    zoomOut,
    zoomReset,
  };
}
