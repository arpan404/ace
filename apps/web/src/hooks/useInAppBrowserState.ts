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
import type { BrowserBridgeRequest } from "@ace/contracts";

import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSetting, useUpdateSettings } from "~/hooks/useSettings";
import {
  buildBrowserClickScript,
  buildBrowserClipboardActionScript,
  buildBrowserCuaActionScript,
  buildBrowserDomSnapshotScript,
  buildBrowserDomCuaActionScript,
  buildBrowserDomCuaTargetScript,
  buildBrowserFillScript,
  buildBrowserLocatorActionScript,
  buildBrowserLocatorTargetScript,
  buildBrowserPlaywrightDomSnapshotScript,
  buildBrowserSelectorTargetScript,
} from "~/lib/browser/bridgeScripts";
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
  type BrowserTabState,
  addBrowserTab,
  closeBrowserTab,
  createBrowserTabState,
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
  type BrowserAgentPointerEffect,
  type BrowserConsoleLogEntry,
  type BrowserDesignSelectionRect,
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
  runBridgeRequest: (request: BrowserBridgeRequest) => Promise<Record<string, unknown>>;
  setActiveTabByIndex: (index: number) => void;
  setDesignerModeActive: (active: boolean) => void;
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

export interface BrowserViewportResizeRequest {
  height?: number;
  panelWidth?: number;
  width?: number;
}

export interface BrowserViewportResizeResult {
  heightControlledByAppWindow: boolean;
  panelWidth: number;
  requestedHeight?: number;
  requestedPanelWidth?: number;
  requestedWidth?: number;
  viewportWidth: number;
}

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
  onResizeViewport?: (request: BrowserViewportResizeRequest) => BrowserViewportResizeResult;
}

const EMPTY_BROWSER_SUGGESTIONS: BrowserSuggestion[] = [];

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArgAny(
  args: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = readStringArg(args, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanArgAny(
  args: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean | undefined {
  for (const key of keys) {
    const value = readBooleanArg(args, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberArgAny(
  args: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const value = readNumberArg(args, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readTimeoutMs(args: Record<string, unknown>, fallbackMs = 5000): number {
  const timeoutMs = readNumberArg(args, "timeoutMs") ?? readNumberArg(args, "timeout_ms");
  if (timeoutMs === undefined) {
    return fallbackMs;
  }
  return Math.max(0, Math.min(timeoutMs, 30000));
}

function readBrowserBridgeKeys(args: Record<string, unknown>): string[] {
  const rawKeys = args.keys;
  if (Array.isArray(rawKeys)) {
    const keys = rawKeys.filter(
      (key): key is string => typeof key === "string" && key.trim().length > 0,
    );
    if (keys.length > 0) {
      return keys;
    }
  }
  const key =
    readStringArgAny(args, ["key", "value", "text"]) ??
    (typeof args.keyCode === "string" && args.keyCode.trim().length > 0 ? args.keyCode : undefined);
  return key ? [key] : ["Enter"];
}

function readBrowserBridgeTabIndexArg(
  args: Record<string, unknown>,
  tabCount: number,
): number | null {
  const zeroBasedIndex = readNumberArgAny(args, ["index", "tabIndex", "tab_index"]);
  if (
    zeroBasedIndex !== undefined &&
    Number.isInteger(zeroBasedIndex) &&
    zeroBasedIndex >= 0 &&
    zeroBasedIndex < tabCount
  ) {
    return zeroBasedIndex;
  }

  const oneBasedIndex = readNumberArgAny(args, ["number", "position", "tabNumber", "tab_number"]);
  if (
    oneBasedIndex !== undefined &&
    Number.isInteger(oneBasedIndex) &&
    oneBasedIndex >= 1 &&
    oneBasedIndex <= tabCount
  ) {
    return oneBasedIndex - 1;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const BROWSER_VIEWPORT_SIZE_SCRIPT = `(() => ({
  devicePixelRatio: window.devicePixelRatio,
  height: window.innerHeight,
  width: window.innerWidth,
}))()`;

function normalizePageViewportSize(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  if (typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  return {
    devicePixelRatio:
      typeof record.devicePixelRatio === "number"
        ? record.devicePixelRatio
        : typeof window !== "undefined"
          ? window.devicePixelRatio
          : 1,
    height,
    width,
  };
}

function normalizeBrowserBridgeRect(value: unknown): BrowserDesignSelectionRect | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const x = record.x;
  const y = record.y;
  const width = record.width;
  const height = record.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return { height, width, x, y };
}

function readBrowserBridgeResultRect(value: unknown): BrowserDesignSelectionRect | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return (
    normalizeBrowserBridgeRect(record.boundingBox) ??
    normalizeBrowserBridgeRect(record.rect) ??
    readBrowserBridgeResultRect(record.element) ??
    readBrowserBridgeResultRect(record.action) ??
    readBrowserBridgeResultRect(record.result)
  );
}

function readBrowserBridgePoint(args: Record<string, unknown>): { x: number; y: number } | null {
  const x = readNumberArg(args, "x");
  const y = readNumberArg(args, "y");
  return x !== undefined && y !== undefined ? { x, y } : null;
}

function readBrowserBridgePath(args: Record<string, unknown>): BrowserAgentPointerEffect["path"] {
  const rawPath = args.path;
  if (!Array.isArray(rawPath)) {
    return undefined;
  }
  const path = rawPath
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const x = record.x;
      const y = record.y;
      return typeof x === "number" &&
        Number.isFinite(x) &&
        typeof y === "number" &&
        Number.isFinite(y)
        ? { x, y }
        : null;
    })
    .filter((point): point is { x: number; y: number } => point !== null);
  return path.length > 0 ? path : undefined;
}

function buildBrowserAgentPointerEffectFromArgs(
  action: BrowserAgentPointerEffect["type"],
  args: Record<string, unknown>,
): BrowserAgentPointerEffect {
  const path = action === "drag" ? readBrowserBridgePath(args) : undefined;
  const point = readBrowserBridgePoint(args);
  const effect: BrowserAgentPointerEffect = {
    type: action,
  };
  if (point) {
    effect.x = point.x;
    effect.y = point.y;
  }
  if (path) {
    effect.path = path;
  }
  if (action === "scroll") {
    effect.scrollX = readNumberArgAny(args, ["scrollX", "scroll_x", "deltaX", "delta_x"]) ?? 0;
    effect.scrollY =
      readNumberArgAny(args, ["scrollY", "scroll_y", "deltaY", "delta_y"]) ??
      (point ? 0 : readNumberArg(args, "y")) ??
      0;
  }
  return effect;
}

function buildBrowserAgentPointerEffectFromResult(
  action: BrowserAgentPointerEffect["type"],
  result: unknown,
  args?: Record<string, unknown>,
): BrowserAgentPointerEffect {
  const effect = buildBrowserAgentPointerEffectFromArgs(action, args ?? {});
  const targetRect = readBrowserBridgeResultRect(result);
  if (targetRect) {
    effect.targetRect = targetRect;
  }
  return {
    ...effect,
  };
}

function normalizeBrowserBridgeLogLevel(value: unknown): BrowserConsoleLogEntry["level"] {
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "debug":
      case "info":
      case "log":
      case "warn":
      case "error":
        return value.toLowerCase() as BrowserConsoleLogEntry["level"];
      case "warning":
        return "warn";
      default:
        return "log";
    }
  }
  if (typeof value === "number" && value >= 2) {
    return "error";
  }
  return "log";
}

function mapBrowserLocatorOperationToAction(operation: string): string | null {
  switch (operation) {
    case "playwright_locator_click":
      return "click";
    case "playwright_locator_count":
      return "count";
    case "playwright_locator_dblclick":
      return "dblclick";
    case "playwright_locator_fill":
      return "fill";
    case "playwright_locator_get_attribute":
      return "get_attribute";
    case "playwright_locator_inner_text":
      return "inner_text";
    case "playwright_locator_is_enabled":
      return "is_enabled";
    case "playwright_locator_is_visible":
      return "is_visible";
    case "playwright_locator_press":
      return "press";
    case "playwright_locator_select_option":
      return "select_option";
    case "playwright_locator_set_checked":
      return "set_checked";
    case "playwright_locator_text_content":
      return "text_content";
    case "playwright_locator_wait_for":
      return "wait_for";
    default:
      return null;
  }
}

export function shouldAutoFocusBrowserAddressBarOnOpen(options: {
  activeTabIsNewTab: boolean;
  browserTabCount: number;
}): boolean {
  return options.activeTabIsNewTab && options.browserTabCount === 1;
}

export function shouldReuseInitialBlankBrowserTabForBridgeNavigation(options: {
  activeTabIsNewTab: boolean;
  browserTabCount: number;
  forceNewTab?: boolean;
  requestedUrlPresent: boolean;
}): boolean {
  return (
    options.requestedUrlPresent &&
    options.forceNewTab !== true &&
    options.activeTabIsNewTab &&
    options.browserTabCount === 1
  );
}

export function resolveNextBrowserTabIndex(
  currentIndex: number,
  tabCount: number,
  direction: -1 | 1,
): number | null {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount) {
    return null;
  }
  return (currentIndex + direction + tabCount) % tabCount;
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
    onResizeViewport,
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
  const browserSessionNameRef = useRef<string | null>(null);
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
  const dismissAddressBarSuggestionOverlay = useCallback(() => {
    setAddressBarSuggestionsDismissed(true);
    setIsAddressBarFocused(false);
    setSelectedSuggestionIndex(-1);
    addressInputRef.current?.blur();
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
      const nextIndex = resolveNextBrowserTabIndex(
        currentIndex,
        browserSession.tabs.length,
        direction,
      );
      if (nextIndex === null) {
        return;
      }
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
      const shouldKeepAddressBarFocused = rawUrl.trim().length === 0;
      if (!shouldKeepAddressBarFocused) {
        dismissAddressBarSuggestionOverlay();
      }
      if (!activeTab || options?.newTab) {
        updateBrowserSession((current) => addBrowserTab(current, { activate: true, url: nextUrl }));
        if (shouldKeepAddressBarFocused) {
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
    [
      activeTab,
      activeTabIsInternal,
      browserSearchEngine,
      dismissAddressBarSuggestionOverlay,
      focusAddressBar,
      updateBrowserSession,
    ],
  );

  const applySuggestion = useCallback(
    (suggestion: BrowserSuggestion) => {
      if (suggestion.kind === "tab" && suggestion.tabId) {
        updateBrowserSession((current) =>
          setActiveBrowserTab(current, suggestion.tabId ?? current.activeTabId),
        );
        dismissAddressBarSuggestionOverlay();
        return;
      }
      setDraftUrl(resolveBrowserSuggestionDraftValue(suggestion));
      openUrl(suggestion.url);
      dismissAddressBarSuggestionOverlay();
    },
    [dismissAddressBarSuggestionOverlay, openUrl, updateBrowserSession],
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

  const resolveBridgeTarget = useCallback(
    (args: Record<string, unknown>) => {
      const tabId = readStringArgAny(args, ["tabId", "tab_id"]) ?? browserSession.activeTabId;
      const tab = browserSession.tabs.find((item) => item.id === tabId);
      if (!tab) {
        throw new Error("Ace browser tab was not found.");
      }
      if (isBrowserInternalTabUrl(tab.url)) {
        throw new Error("Ace browser tab is still on an internal page. Open a URL first.");
      }
      const handle = webviewHandlesRef.current.get(tab.id);
      if (!handle) {
        throw new Error("Ace browser tab is not ready yet.");
      }
      const snapshot = handle.getSnapshot() ?? {
        canGoBack: false,
        canGoForward: false,
        devToolsOpen: false,
        loading: false,
        title: tab.title,
        url: tab.url,
      };
      return { handle, snapshot, tab };
    },
    [browserSession.activeTabId, browserSession.tabs],
  );

  const runBridgeRequest = useCallback(
    async (request: BrowserBridgeRequest): Promise<Record<string, unknown>> => {
      const args = request.args as Record<string, unknown>;
      const operation = request.operation;
      const readBridgeTabSnapshot = (tab: BrowserTabState) => {
        const handle = webviewHandlesRef.current.get(tab.id);
        const snapshot = handle?.getSnapshot() ?? {
          canGoBack: false,
          canGoForward: false,
          devToolsOpen: false,
          loading: false,
          title: tab.title,
          url: tab.url,
        };
        return {
          active: tab.id === browserSession.activeTabId,
          id: tab.id,
          ...snapshot,
        };
      };
      const activateBridgeTab = (tab: BrowserTabState) => {
        dismissAddressBarSuggestionOverlay();
        updateBrowserSession((current) => setActiveBrowserTab(current, tab.id));
        return {
          ok: true,
          tab: {
            ...readBridgeTabSnapshot(tab),
            active: true,
          },
        };
      };
      const replaceBridgeTabUrl = (
        tab: BrowserTabState,
        url: string,
        options?: { activate?: boolean },
      ) => {
        dismissAddressBarSuggestionOverlay();
        updateBrowserSession((current) => {
          const nextState = updateBrowserTab(current, tab.id, { url });
          return options?.activate === false ? nextState : setActiveBrowserTab(nextState, tab.id);
        });
        if (!isBrowserInternalTabUrl(tab.url)) {
          webviewHandlesRef.current.get(tab.id)?.navigate(url);
        }
        return {
          ok: true,
          reusedInitialBlankTab: isBrowserNewTabUrl(tab.url),
          tab: {
            active: options?.activate !== false,
            id: tab.id,
            title: tab.title,
            url,
          },
          url,
        };
      };
      const shouldReuseActiveInitialBlankTabForUrl = (url: string) =>
        shouldReuseInitialBlankBrowserTabForBridgeNavigation({
          activeTabIsNewTab,
          browserTabCount: browserSession.tabs.length,
          forceNewTab: readBooleanArgAny(args, ["forceNewTab", "force_new_tab"]) === true,
          requestedUrlPresent: url.trim().length > 0,
        });
      switch (operation) {
        case "name_session": {
          browserSessionNameRef.current =
            readStringArgAny(args, ["name", "sessionName", "session_name"]) ?? null;
          return { name: browserSessionNameRef.current, ok: true };
        }
        case "list_tabs":
          return {
            tabs: browserSession.tabs.map((tab) => ({
              active: tab.id === browserSession.activeTabId,
              id: tab.id,
              title: tab.title,
              url: tab.url,
              ...(tabRuntimeById[tab.id] ? { runtime: tabRuntimeById[tab.id] } : {}),
            })),
          };
        case "get_tab":
        case "selected_tab": {
          const tabId =
            operation === "get_tab"
              ? readStringArgAny(args, ["tabId", "tab_id"])
              : (readStringArgAny(args, ["tabId", "tab_id"]) ?? browserSession.activeTabId);
          const tab = browserSession.tabs.find((item) => item.id === tabId);
          if (!tab) {
            throw new Error("Ace browser tab was not found.");
          }
          return {
            tab: readBridgeTabSnapshot(tab),
          };
        }
        case "select_tab":
        case "switch_tab":
        case "activate_tab": {
          const requestedTabId = readStringArgAny(args, ["tabId", "tab_id", "id"]);
          const requestedIndex = readBrowserBridgeTabIndexArg(args, browserSession.tabs.length);
          const tab = requestedTabId
            ? browserSession.tabs.find((item) => item.id === requestedTabId)
            : requestedIndex !== null
              ? browserSession.tabs[requestedIndex]
              : null;
          if (!tab) {
            throw new Error("select_tab requires a valid tabId/tab_id/id, index, or tabNumber.");
          }
          return activateBridgeTab(tab);
        }
        case "next_tab":
        case "select_next_tab":
        case "previous_tab":
        case "select_previous_tab": {
          const direction =
            operation === "previous_tab" || operation === "select_previous_tab" ? -1 : 1;
          const currentIndex = browserSession.tabs.findIndex(
            (tab) => tab.id === browserSession.activeTabId,
          );
          const nextIndex = resolveNextBrowserTabIndex(
            currentIndex,
            browserSession.tabs.length,
            direction,
          );
          const tab = nextIndex === null ? null : browserSession.tabs[nextIndex];
          if (!tab) {
            throw new Error("No browser tab is available to select.");
          }
          return activateBridgeTab(tab);
        }
        case "create_tab":
        case "new_tab": {
          const requestedUrl = readStringArg(args, "url");
          const nextUrl = requestedUrl
            ? normalizeBrowserInput(requestedUrl, browserSearchEngine)
            : BROWSER_NEW_TAB_URL;
          if (requestedUrl) {
            dismissAddressBarSuggestionOverlay();
          }
          if (requestedUrl && activeTab && shouldReuseActiveInitialBlankTabForUrl(requestedUrl)) {
            return replaceBridgeTabUrl(activeTab, nextUrl);
          }
          const nextTab = createBrowserTabState(nextUrl);
          updateBrowserSession((current) => ({
            ...current,
            activeTabId: nextTab.id,
            tabs: [...current.tabs, nextTab],
          }));
          return {
            ok: true,
            tab: {
              active: true,
              id: nextTab.id,
              title: nextTab.title,
              url: nextTab.url,
            },
          };
        }
        case "close_tab": {
          const tabId =
            readStringArgAny(args, ["tabId", "tab_id"]) ??
            browserSession.activeTabId ??
            browserSession.tabs[0]?.id;
          if (!tabId) {
            throw new Error("close_tab requires an open tab.");
          }
          closeTab(tabId);
          return { ok: true, tabId };
        }
        case "open_url": {
          const url = readStringArg(args, "url");
          if (!url) {
            throw new Error("open_url requires a url argument.");
          }
          const newTab = readBooleanArg(args, "newTab");
          const normalizedUrl = normalizeBrowserInput(url, browserSearchEngine);
          if (activeTab && shouldReuseActiveInitialBlankTabForUrl(url)) {
            return replaceBridgeTabUrl(activeTab, normalizedUrl);
          }
          openUrl(url, newTab === undefined ? undefined : { newTab });
          return {
            ok: true,
            url: normalizedUrl,
          };
        }
        case "navigate_tab_url": {
          const url = readStringArg(args, "url");
          if (!url) {
            throw new Error("navigate_tab_url requires a url argument.");
          }
          const targetTabId = readStringArgAny(args, ["tabId", "tab_id"]);
          const normalizedUrl = normalizeBrowserInput(url, browserSearchEngine);
          if (!targetTabId || targetTabId === browserSession.activeTabId) {
            const newTab = readBooleanArg(args, "newTab");
            if (activeTab && shouldReuseActiveInitialBlankTabForUrl(url)) {
              return replaceBridgeTabUrl(activeTab, normalizedUrl);
            }
            openUrl(url, newTab === undefined ? undefined : { newTab });
            return { ok: true, url: normalizedUrl };
          }
          const tab = browserSession.tabs.find((item) => item.id === targetTabId);
          if (!tab) {
            throw new Error("Ace browser tab was not found.");
          }
          dismissAddressBarSuggestionOverlay();
          updateBrowserSession((current) =>
            updateBrowserTab(current, targetTabId, { url: normalizedUrl }),
          );
          webviewHandlesRef.current.get(targetTabId)?.navigate(normalizedUrl);
          return {
            ok: true,
            tabId: targetTabId,
            url: normalizedUrl,
          };
        }
        case "resize_browser":
        case "set_viewport_size":
        case "get_viewport_size": {
          if (!onResizeViewport) {
            throw new Error("Ace browser viewport resizing is unavailable.");
          }
          const requestedWidth = readNumberArgAny(args, [
            "width",
            "viewportWidth",
            "viewport_width",
          ]);
          const requestedHeight = readNumberArgAny(args, [
            "height",
            "viewportHeight",
            "viewport_height",
          ]);
          const requestedPanelWidth = readNumberArgAny(args, [
            "panelWidth",
            "panel_width",
            "rightSidePanelWidth",
            "right_side_panel_width",
          ]);
          const viewport = onResizeViewport({
            ...(requestedHeight !== undefined ? { height: requestedHeight } : {}),
            ...(requestedPanelWidth !== undefined ? { panelWidth: requestedPanelWidth } : {}),
            ...(requestedWidth !== undefined ? { width: requestedWidth } : {}),
          });
          if (requestedWidth !== undefined || requestedPanelWidth !== undefined) {
            await sleep(120);
          }

          const pageViewport = activeTab
            ? normalizePageViewportSize(
                await webviewHandlesRef.current
                  .get(activeTab.id)
                  ?.executeJavaScript(BROWSER_VIEWPORT_SIZE_SCRIPT)
                  .catch(() => null),
              )
            : null;

          return {
            ok: true,
            pageViewport,
            viewport,
          };
        }
        case "get_browser_zoom":
        case "set_browser_zoom":
        case "reset_browser_zoom":
        case "zoom_browser": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          if (operation === "reset_browser_zoom") {
            handle.setZoomFactor(1);
          } else if (operation === "set_browser_zoom") {
            const requestedZoom = readNumberArgAny(args, ["zoomFactor", "zoom", "factor"]);
            if (requestedZoom === undefined) {
              throw new Error("set_browser_zoom requires zoomFactor, zoom, or factor.");
            }
            handle.setZoomFactor(requestedZoom);
          } else if (operation === "zoom_browser") {
            const requestedZoom = readNumberArgAny(args, ["zoomFactor", "zoom", "factor"]);
            const zoomDelta = readNumberArgAny(args, ["delta", "zoomDelta", "zoom_delta"]);
            if (requestedZoom !== undefined) {
              handle.setZoomFactor(requestedZoom);
            } else if (zoomDelta !== undefined) {
              handle.setZoomFactor(handle.getZoomFactor() + zoomDelta);
            } else {
              throw new Error("zoom_browser requires zoomFactor/factor or delta.");
            }
          }
          if (operation !== "get_browser_zoom") {
            await sleep(80);
          }

          const pageViewport = normalizePageViewportSize(
            await handle.executeJavaScript(BROWSER_VIEWPORT_SIZE_SCRIPT).catch(() => null),
          );

          return {
            browserZoomFactor: handle.getZoomFactor(),
            coordinateSpace: "css-pixels",
            ok: true,
            pageViewport,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "playwright_dom_snapshot": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const domSnapshot = await handle.executeJavaScript(
            buildBrowserPlaywrightDomSnapshotScript(),
          );
          return {
            domSnapshot,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "dom_cua_get_visible_dom":
        case "dom_snapshot": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const dom = await handle.executeJavaScript(buildBrowserDomSnapshotScript());
          return {
            dom,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "cua_get_visible_screenshot":
        case "playwright_screenshot":
        case "screenshot": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const imageDataUrl = await handle.captureVisiblePage();
          const pageViewport = normalizePageViewportSize(
            await handle.executeJavaScript(BROWSER_VIEWPORT_SIZE_SCRIPT).catch(() => null),
          );
          return {
            browserZoomFactor: handle.getZoomFactor(),
            coordinateSpace: "css-pixels",
            imageDataUrl,
            mimeType: "image/png",
            pageViewport,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "cua_click":
        case "cua_double_click":
        case "cua_drag":
        case "cua_keypress":
        case "cua_move":
        case "cua_scroll":
        case "cua_type": {
          const action = operation.replace(/^cua_/u, "").replace("double_click", "double_click");
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromArgs(
              action as BrowserAgentPointerEffect["type"],
              args,
            ),
          );
          if (action === "keypress") {
            await handle.pressKeys(readBrowserBridgeKeys(args));
            return { ok: true, tab: { id: tab.id, ...snapshot } };
          }
          const result = await handle.executeJavaScript(buildBrowserCuaActionScript(action, args));
          return { ok: true, result, tab: { id: tab.id, ...snapshot } };
        }
        case "dom_cua_click":
        case "dom_cua_double_click":
        case "dom_cua_keypress":
        case "dom_cua_scroll":
        case "dom_cua_type": {
          const action = operation.replace(/^dom_cua_/u, "");
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const target = await handle.executeJavaScript(
            buildBrowserDomCuaTargetScript(action, args),
          );
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromResult(
              action as BrowserAgentPointerEffect["type"],
              target,
              args,
            ),
          );
          const result = await handle.executeJavaScript(
            buildBrowserDomCuaActionScript(action, args),
          );
          return { ok: true, result, tab: { id: tab.id, ...snapshot } };
        }
        case "click": {
          const selector = readStringArg(args, "selector");
          if (!selector) {
            throw new Error("click requires a selector argument.");
          }
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const target = await handle.executeJavaScript(buildBrowserSelectorTargetScript(selector));
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromResult("click", target),
          );
          const action = await handle.executeJavaScript(buildBrowserClickScript(selector));
          return {
            action,
            ok: true,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "fill": {
          const selector = readStringArg(args, "selector");
          const value = typeof args.value === "string" ? args.value : "";
          if (!selector) {
            throw new Error("fill requires a selector argument.");
          }
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const target = await handle.executeJavaScript(buildBrowserSelectorTargetScript(selector));
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromResult("type", target),
          );
          const action = await handle.executeJavaScript(buildBrowserFillScript(selector, value));
          return {
            action,
            ok: true,
            tab: {
              id: tab.id,
              ...snapshot,
            },
          };
        }
        case "playwright_locator_click":
        case "playwright_locator_count":
        case "playwright_locator_dblclick":
        case "playwright_locator_fill":
        case "playwright_locator_get_attribute":
        case "playwright_locator_inner_text":
        case "playwright_locator_is_enabled":
        case "playwright_locator_is_visible":
        case "playwright_locator_press":
        case "playwright_locator_select_option":
        case "playwright_locator_set_checked":
        case "playwright_locator_text_content":
        case "playwright_locator_wait_for": {
          const action = mapBrowserLocatorOperationToAction(operation);
          if (!action) {
            throw new Error(`Unsupported locator operation: ${operation}`);
          }
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const animatedAction =
            action === "click" ||
            action === "dblclick" ||
            action === "fill" ||
            action === "press" ||
            action === "select_option" ||
            action === "set_checked"
              ? action === "dblclick"
                ? "double_click"
                : action === "press"
                  ? "keypress"
                  : action === "fill"
                    ? "type"
                    : "click"
              : null;
          if (animatedAction) {
            const target = await handle.executeJavaScript(buildBrowserLocatorTargetScript(args));
            await handle.animateAgentPointer(
              buildBrowserAgentPointerEffectFromResult(animatedAction, target, args),
            );
          }
          const result = await handle.executeJavaScript(
            buildBrowserLocatorActionScript(action, args),
          );
          return { ok: true, result, tab: { id: tab.id, ...snapshot } };
        }
        case "playwright_wait_for_load_state": {
          const { handle, tab } = resolveBridgeTarget(args);
          const timeoutMs = readTimeoutMs(args);
          const startedAt = Date.now();
          while (Date.now() - startedAt <= timeoutMs) {
            if (handle.getSnapshot()?.loading === false) {
              return { ok: true, tabId: tab.id };
            }
            await sleep(100);
          }
          throw new Error("Timed out waiting for browser load state.");
        }
        case "playwright_wait_for_timeout": {
          const timeoutMs = readTimeoutMs(args, 1000);
          await sleep(timeoutMs);
          return { ok: true, timeoutMs };
        }
        case "playwright_wait_for_url": {
          const expectedUrl = readStringArg(args, "url");
          if (!expectedUrl) {
            throw new Error("playwright_wait_for_url requires a url argument.");
          }
          const { handle, tab } = resolveBridgeTarget(args);
          const timeoutMs = readTimeoutMs(args);
          const startedAt = Date.now();
          while (Date.now() - startedAt <= timeoutMs) {
            const currentUrl = handle.getSnapshot()?.url ?? "";
            if (currentUrl === expectedUrl || currentUrl.includes(expectedUrl)) {
              return { ok: true, tabId: tab.id, url: currentUrl };
            }
            await sleep(100);
          }
          throw new Error("Timed out waiting for browser URL.");
        }
        case "tab_clipboard_read_text": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const result = await handle.executeJavaScript(
            buildBrowserClipboardActionScript("read_text", args),
          );
          return { ok: true, result, tab: { id: tab.id, ...snapshot } };
        }
        case "tab_clipboard_write_text": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const result = await handle.executeJavaScript(
            buildBrowserClipboardActionScript("write_text", args),
          );
          return { ok: true, result, tab: { id: tab.id, ...snapshot } };
        }
        case "tab_dev_logs": {
          const { handle, snapshot, tab } = resolveBridgeTarget(args);
          const levels = Array.isArray(args.levels)
            ? args.levels.map(normalizeBrowserBridgeLogLevel)
            : undefined;
          const logOptions: Parameters<typeof handle.readConsoleLogs>[0] = {};
          const filter = readStringArg(args, "filter");
          const limit = readNumberArg(args, "limit");
          if (filter) {
            logOptions.filter = filter;
          }
          if (levels) {
            logOptions.levels = levels;
          }
          if (limit !== undefined) {
            logOptions.limit = limit;
          }
          return {
            logs: handle.readConsoleLogs(logOptions),
            tab: { id: tab.id, ...snapshot },
          };
        }
        case "back": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.goBack();
          return { ok: true, tabId: tab.id };
        }
        case "navigate_tab_back": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.goBack();
          return { ok: true, tabId: tab.id };
        }
        case "forward": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.goForward();
          return { ok: true, tabId: tab.id };
        }
        case "navigate_tab_forward": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.goForward();
          return { ok: true, tabId: tab.id };
        }
        case "reload": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.reload();
          return { ok: true, tabId: tab.id };
        }
        case "navigate_tab_reload": {
          const { handle, tab } = resolveBridgeTarget(args);
          handle.reload();
          return { ok: true, tabId: tab.id };
        }
        default:
          throw new Error(`Unsupported Ace browser operation: ${request.operation}`);
      }
    },
    [
      activeTab,
      browserSearchEngine,
      browserSession.activeTabId,
      browserSession.tabs,
      closeTab,
      dismissAddressBarSuggestionOverlay,
      onResizeViewport,
      openUrl,
      resolveBridgeTarget,
      tabRuntimeById,
      updateBrowserSession,
    ],
  );

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
        current.tool === tool && current.active
          ? current
          : {
              ...current,
              active: true,
              tool,
            },
      );
    },
    [setDesignerState],
  );
  const setDesignerModeActive = useCallback(
    (active: boolean) => {
      setDesignerState((current) =>
        current.active === active
          ? current
          : {
              ...current,
              active,
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
        const shouldDeactivate = current.active && current.tool === tool;
        if (shouldDeactivate) {
          return {
            ...current,
            active: false,
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
  const runBridgeRequestEvent = useEffectEvent(runBridgeRequest);
  const setActiveTabByIndexEvent = useEffectEvent(setActiveTabByIndex);
  const setDesignerModeActiveEvent = useEffectEvent(setDesignerModeActive);
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
      runBridgeRequest: (request) => runBridgeRequestEvent(request),
      setActiveTabByIndex: (index) => setActiveTabByIndexEvent(index),
      setDesignerModeActive: (active) => setDesignerModeActiveEvent(active),
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
    if (!activeTabIsInternal) {
      setAddressBarSuggestionsDismissed(true);
    }
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
