import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BrowserBridgeRequest } from "@ace/contracts";
import type { BrowserSearchEngine } from "@ace/contracts/settings";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEffectEvent } from "~/hooks/useEffectEvent";
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
  type BrowserHistory,
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
  type BrowserSessionStorage,
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
  type BrowserFindOptions,
  type BrowserTabHandle,
  type BrowserTabRuntimeState,
  type BrowserTabSnapshot,
  type BrowserTabSnapshotOptions,
  DEFAULT_BROWSER_TAB_RUNTIME_STATE,
} from "~/lib/browser/types";
import { normalizeBrowserInput } from "~/lib/browser/url";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface InAppBrowserController {
  activateTab: (tabId: string) => void;
  clearAgentPointers: () => void;
  closeActiveTab: () => void;
  closeTab: (tabId: string) => void;
  closeDevTools: () => void;
  findInPage: (query: string, options?: BrowserFindOptions) => void;
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
  stopFindInPage: () => void;
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
  active?: boolean;
  designerModeEnabled?: boolean;
  mode: InAppBrowserMode;
  open: boolean;
  scopeId?: string;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  onClose?: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  onFindInPageShortcut?: () => void;
  onResizeViewport?: (request: BrowserViewportResizeRequest) => BrowserViewportResizeResult;
  onToggleRightPanelFloatingChat?: () => void;
  onToggleRightPanelFullscreen?: () => void;
}

const EMPTY_BROWSER_SUGGESTIONS: BrowserSuggestion[] = [];

async function copyBrowserAddress(url: string): Promise<void> {
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
}

function useStableCallback<TArgs extends readonly unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}

interface BrowserSessionProjection {
  readonly activeRuntime: BrowserTabRuntimeState;
  readonly activeTab: BrowserTabState | undefined;
  readonly activeTabId: string | null;
  readonly activeTabIndex: number;
  readonly activeTabIsInternal: boolean;
  readonly activeTabIsNewTab: boolean;
  readonly activeTabUrl: string;
  readonly openTabs: readonly BrowserTabState[];
  readonly tabCount: number;
  readonly tabsById: ReadonlyMap<string, BrowserTabState>;
}

interface BrowserAddressBarState {
  readonly addressBarSuggestions: readonly BrowserSuggestion[];
  readonly dismissAddressBarSuggestionOverlay: () => void;
  readonly draftUrl: string;
  readonly isAddressBarFocused: boolean;
  readonly selectedSuggestionIndex: number;
  readonly setDraftUrl: (value: string) => void;
  readonly setIsAddressBarFocused: (value: boolean) => void;
  readonly setSelectedSuggestionIndex: (next: number | ((current: number) => number)) => void;
  readonly showAddressBarSuggestionOverlay: () => void;
  readonly showAddressBarSuggestions: boolean;
  readonly syncDraftUrlFromActiveTab: (input: {
    readonly activeTabIsInternal: boolean;
    readonly activeTabUrl: string;
  }) => void;
}

function useBrowserSessionProjection(
  browserSession: BrowserSessionStorage,
  tabRuntimeById: Readonly<Record<string, BrowserTabRuntimeState>>,
): BrowserSessionProjection {
  const tabs = browserSession.tabs;
  const activeTabIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === browserSession.activeTabId),
  );
  const activeTab =
    tabs.find((tab) => tab.id === browserSession.activeTabId) ?? browserSession.tabs[0];
  const activeTabId = activeTab?.id ?? null;
  const activeTabUrl = activeTab?.url ?? "";
  const activeRuntime = activeTab
    ? (tabRuntimeById[activeTab.id] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE)
    : DEFAULT_BROWSER_TAB_RUNTIME_STATE;
  const tabsById = new Map<string, BrowserTabState>();
  const openTabs: BrowserTabState[] = [];

  for (const tab of tabs) {
    tabsById.set(tab.id, tab);
    if (!isBrowserInternalTabUrl(tab.url)) {
      openTabs.push(tab);
    }
  }

  return {
    activeRuntime,
    activeTab,
    activeTabId,
    activeTabIndex: activeTab ? activeTabIndex : -1,
    activeTabIsInternal: activeTab ? isBrowserInternalTabUrl(activeTab.url) : false,
    activeTabIsNewTab: activeTab ? isBrowserNewTabUrl(activeTab.url) : false,
    activeTabUrl,
    openTabs,
    tabCount: tabs.length,
    tabsById,
  };
}

function useBrowserAddressBarState(input: {
  readonly activeTabId: string | null;
  readonly activeTabUrl: string;
  readonly browserHistory: BrowserHistory;
  readonly browserSearchEngine: BrowserSearchEngine;
  readonly openTabs: readonly BrowserTabState[];
}): BrowserAddressBarState {
  const [draftUrl, setDraftUrl] = useState("");
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [addressBarSuggestionsDismissed, setAddressBarSuggestionsDismissed] = useState(false);
  const [selectedSuggestionState, setSelectedSuggestionState] = useState({
    index: -1,
    query: "",
  });

  const showAddressBarSuggestions = shouldShowBrowserAddressBarSuggestions({
    isAddressBarFocused,
    suggestionsDismissed: addressBarSuggestionsDismissed,
  });

  const addressBarSuggestions = showAddressBarSuggestions
    ? buildBrowserSuggestions(draftUrl, {
        ...(input.activeTabId ? { activeTabId: input.activeTabId } : {}),
        ...(input.activeTabUrl ? { activePageUrl: input.activeTabUrl } : {}),
        history: input.browserHistory,
        openTabs: input.openTabs,
        searchEngine: input.browserSearchEngine,
      })
    : EMPTY_BROWSER_SUGGESTIONS;

  const selectedSuggestionIndex =
    selectedSuggestionState.query === draftUrl &&
    selectedSuggestionState.index < addressBarSuggestions.length
      ? selectedSuggestionState.index
      : -1;

  const setSelectedSuggestionIndex = (next: number | ((current: number) => number)) => {
    setSelectedSuggestionState((current) => {
      const currentIndex =
        current.query === draftUrl && current.index < addressBarSuggestions.length
          ? current.index
          : -1;
      const nextIndex = typeof next === "function" ? next(currentIndex) : next;
      return {
        index: nextIndex,
        query: draftUrl,
      };
    });
  };

  const showAddressBarSuggestionOverlay = () => {
    setAddressBarSuggestionsDismissed(false);
  };

  const dismissAddressBarSuggestionOverlay = () => {
    setAddressBarSuggestionsDismissed(true);
    setIsAddressBarFocused(false);
    setSelectedSuggestionIndex(-1);
  };

  const syncDraftUrlFromActiveTab = useCallback(
    (next: { readonly activeTabIsInternal: boolean; readonly activeTabUrl: string }) => {
      setDraftUrl(next.activeTabIsInternal ? "" : next.activeTabUrl);
      if (!next.activeTabIsInternal) {
        setAddressBarSuggestionsDismissed(true);
      }
    },
    [],
  );

  return {
    addressBarSuggestions,
    dismissAddressBarSuggestionOverlay,
    draftUrl,
    isAddressBarFocused,
    selectedSuggestionIndex,
    setDraftUrl,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    showAddressBarSuggestionOverlay,
    showAddressBarSuggestions,
    syncDraftUrlFromActiveTab,
  };
}

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

async function pollUntilResult<TResult>(options: {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly errorMessage: string;
  readonly readResult: () => TResult | null;
}): Promise<TResult> {
  const deadline = Date.now() + options.timeoutMs;
  const poll = async (): Promise<TResult> => {
    const result = options.readResult();
    if (result !== null) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(options.errorMessage);
    }
    await sleep(options.intervalMs);
    return poll();
  };
  return poll();
}

const BROWSER_BRIDGE_TARGET_WAIT_MS = 2500;
const BROWSER_BRIDGE_READ_CACHE_TTL_MS = 250;

type BrowserHandleWaiter = (handle: BrowserTabHandle) => void;
type BrowserBridgeReadCacheEntry = {
  readonly cachedAt: number;
  readonly result: Record<string, unknown>;
};

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
  const path: Array<{ x: number; y: number }> = [];
  for (const item of rawPath) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const x = record.x;
    const y = record.y;
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y)
    ) {
      path.push({ x, y });
    }
  }
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

export type BrowserAddressBarEnterTarget =
  | { kind: "suggestion"; suggestion: BrowserSuggestion }
  | { kind: "draft" };

export function resolveBrowserAddressBarEnterTarget(options: {
  selectedSuggestionIndex: number;
  suggestions: readonly BrowserSuggestion[];
}): BrowserAddressBarEnterTarget {
  const suggestion = options.suggestions[options.selectedSuggestionIndex];
  return suggestion ? { kind: "suggestion", suggestion } : { kind: "draft" };
}

export function shouldShowBrowserAddressBarSuggestions(options: {
  isAddressBarFocused: boolean;
  suggestionsDismissed: boolean;
}): boolean {
  return options.isAddressBarFocused && !options.suggestionsDismissed;
}

export function useInAppBrowserState(options: UseInAppBrowserStateOptions) {
  const {
    active = true,
    designerModeEnabled = true,
    mode,
    onActiveRuntimeStateChange,
    onClose,
    onControllerChange,
    onFindInPageShortcut,
    onResizeViewport,
    onToggleRightPanelFloatingChat,
    onToggleRightPanelFullscreen,
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
  const webviewHandlesRef = useRef<Map<string, BrowserTabHandle>>(null!);
  if (webviewHandlesRef.current === null) {
    webviewHandlesRef.current = new Map<string, BrowserTabHandle>();
  }
  const webviewHandleWaitersRef = useRef<Map<string, Set<BrowserHandleWaiter>>>(null!);
  if (webviewHandleWaitersRef.current === null) {
    webviewHandleWaitersRef.current = new Map<string, Set<BrowserHandleWaiter>>();
  }
  const bridgeReadCacheRef = useRef<Map<string, BrowserBridgeReadCacheEntry>>(null!);
  if (bridgeReadCacheRef.current === null) {
    bridgeReadCacheRef.current = new Map<string, BrowserBridgeReadCacheEntry>();
  }
  const browserSessionNameRef = useRef<string | null>(null);
  const lastRecordedBrowserHistoryUrlByTabRef = useRef<Map<string, string>>(null!);
  if (lastRecordedBrowserHistoryUrlByTabRef.current === null) {
    lastRecordedBrowserHistoryUrlByTabRef.current = new Map<string, string>();
  }
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
  const [browserResetKey, setBrowserResetKey] = useState(0);
  const [isRepairingStorage, setIsRepairingStorage] = useState(false);
  const [tabRuntimeById, setTabRuntimeById] = useState<Record<string, BrowserTabRuntimeState>>({});
  const updateBrowserSession = (
    updater: (state: typeof browserSession) => typeof browserSession,
  ) => {
    setBrowserSession((current) =>
      normalizeBrowserSessionState(updater(current), BROWSER_NEW_TAB_URL, resolveViewportHeight()),
    );
  };

  const {
    activeRuntime,
    activeTabId,
    activeTab,
    activeTabIndex,
    activeTabIsInternal,
    activeTabIsNewTab,
    activeTabUrl,
    openTabs,
    tabCount,
    tabsById,
  } = useBrowserSessionProjection(browserSession, tabRuntimeById);
  const {
    addressBarSuggestions,
    dismissAddressBarSuggestionOverlay,
    draftUrl,
    isAddressBarFocused,
    selectedSuggestionIndex,
    setDraftUrl,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    showAddressBarSuggestionOverlay,
    showAddressBarSuggestions,
    syncDraftUrlFromActiveTab,
  } = useBrowserAddressBarState({
    browserHistory,
    browserSearchEngine,
    activeTabId,
    activeTabUrl,
    openTabs,
  });

  const focusAddressBar = () => {
    window.requestAnimationFrame(() => {
      const input = addressInputRef.current;
      if (!input) {
        return;
      }
      showAddressBarSuggestionOverlay();
      input.focus();
      input.select();
    });
  };
  const dismissAddressBarSuggestionOverlayAndBlur = () => {
    dismissAddressBarSuggestionOverlay();
    addressInputRef.current?.blur();
  };

  const setActiveTabByIndex = (index: number) => {
    const nextTab = browserSession.tabs[index];
    if (!nextTab) {
      return;
    }
    updateBrowserSession((current) => setActiveBrowserTab(current, nextTab.id));
    setSelectedSuggestionIndex(-1);
  };

  const moveTabSelection = (direction: -1 | 1) => {
    if (!activeTab || tabCount <= 1) {
      return;
    }
    const nextIndex = resolveNextBrowserTabIndex(activeTabIndex, tabCount, direction);
    if (nextIndex === null) {
      return;
    }
    setActiveTabByIndex(nextIndex);
  };

  const openNewTab = () => {
    updateBrowserSession((current) =>
      addBrowserTab(current, {
        activate: true,
        url: BROWSER_NEW_TAB_URL,
      }),
    );
    focusAddressBar();
  };

  const activateTab = (tabId: string) => {
    updateBrowserSession((current) => setActiveBrowserTab(current, tabId));
  };

  const closeTab = (tabId: string) => {
    if (tabCount <= 1 && tabsById.has(tabId)) {
      onClose?.();
      return;
    }
    updateBrowserSession((current) => closeBrowserTab(current, tabId, BROWSER_NEW_TAB_URL));
  };

  const reorderTabs = (draggedTabId: string, targetTabId: string) => {
    updateBrowserSession((current) => reorderBrowserTab(current, draggedTabId, targetTabId));
  };

  const closeActiveTab = () => {
    if (!activeTab) {
      return;
    }
    if (tabCount <= 1) {
      onClose?.();
      return;
    }
    closeTab(activeTab.id);
  };

  const clearBridgeReadCache = (tabId?: string) => {
    if (!tabId) {
      bridgeReadCacheRef.current.clear();
      return;
    }
    for (const key of bridgeReadCacheRef.current.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        bridgeReadCacheRef.current.delete(key);
      }
    }
  };

  const zoomIn = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    clearBridgeReadCache(activeTab.id);
    webviewHandlesRef.current.get(activeTab.id)?.zoomIn();
  };

  const zoomOut = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    clearBridgeReadCache(activeTab.id);
    webviewHandlesRef.current.get(activeTab.id)?.zoomOut();
  };

  const zoomReset = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    clearBridgeReadCache(activeTab.id);
    webviewHandlesRef.current.get(activeTab.id)?.zoomReset();
  };

  const findInPage = (query: string, options?: BrowserFindOptions) => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    webviewHandlesRef.current.get(activeTab.id)?.findInPage(query, options);
  };

  const stopFindInPage = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    webviewHandlesRef.current.get(activeTab.id)?.stopFindInPage("clearSelection");
  };

  const openUrl = (rawUrl: string, options?: { newTab?: boolean }) => {
    const nextUrl = normalizeBrowserInput(rawUrl, browserSearchEngine);
    const shouldKeepAddressBarFocused = rawUrl.trim().length === 0;
    if (!shouldKeepAddressBarFocused) {
      dismissAddressBarSuggestionOverlayAndBlur();
    }
    if (!activeTab || options?.newTab) {
      clearBridgeReadCache();
      updateBrowserSession((current) => addBrowserTab(current, { activate: true, url: nextUrl }));
      if (shouldKeepAddressBarFocused) {
        focusAddressBar();
      }
      return;
    }
    clearBridgeReadCache(activeTab.id);
    updateBrowserSession((current) => updateBrowserTab(current, activeTab.id, { url: nextUrl }));
    webviewHandlesRef.current.get(activeTab.id)?.navigate(nextUrl);
  };

  const applySuggestion = (suggestion: BrowserSuggestion) => {
    if (suggestion.kind === "tab" && suggestion.tabId) {
      updateBrowserSession((current) =>
        setActiveBrowserTab(current, suggestion.tabId ?? current.activeTabId),
      );
      dismissAddressBarSuggestionOverlayAndBlur();
      return;
    }
    setDraftUrl(resolveBrowserSuggestionDraftValue(suggestion));
    openUrl(suggestion.url);
    dismissAddressBarSuggestionOverlayAndBlur();
  };

  const showBrowserContextMenuFallback = async (
    tabId: string,
    position: { x: number; y: number },
  ) => {
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
        clearBridgeReadCache(tabId);
        handle?.goBack();
        return;
      case "forward":
        clearBridgeReadCache(tabId);
        handle?.goForward();
        return;
      case "reload":
        clearBridgeReadCache(tabId);
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
        clearBridgeReadCache(tabId);
        if (handle?.isDevToolsOpen()) {
          handle.closeDevTools();
        } else {
          handle?.openDevTools();
        }
        return;
      default:
    }
  };

  const handleWebviewContextMenuFallbackRequest = (
    tabId: string,
    position: { x: number; y: number },
    requestedAt: number,
  ) => {
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
  };

  const goBack = () => {
    if (!activeTab) return;
    clearBridgeReadCache(activeTab.id);
    webviewHandlesRef.current.get(activeTab.id)?.goBack();
  };

  const goForward = () => {
    if (!activeTab) return;
    clearBridgeReadCache(activeTab.id);
    webviewHandlesRef.current.get(activeTab.id)?.goForward();
  };

  const reload = () => {
    if (!activeTab) return;
    clearBridgeReadCache(activeTab.id);
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (activeRuntime.loading) {
      handle?.stop();
      return;
    }
    handle?.reload();
  };

  const clearAgentPointers = () => {
    for (const handle of webviewHandlesRef.current.values()) {
      handle.clearAgentPointer();
    }
  };

  const waitForWebviewHandle = (tabId: string): Promise<BrowserTabHandle> => {
    const existingHandle = webviewHandlesRef.current.get(tabId);
    if (existingHandle) {
      return Promise.resolve(existingHandle);
    }

    return new Promise((resolve, reject) => {
      let timeoutHandle: number;
      const waiters = webviewHandleWaitersRef.current.get(tabId) ?? new Set<BrowserHandleWaiter>();
      const waiter: BrowserHandleWaiter = (handle) => {
        window.clearTimeout(timeoutHandle);
        waiters.delete(waiter);
        if (waiters.size === 0) {
          webviewHandleWaitersRef.current.delete(tabId);
        }
        resolve(handle);
      };
      waiters.add(waiter);
      webviewHandleWaitersRef.current.set(tabId, waiters);
      timeoutHandle = window.setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          webviewHandleWaitersRef.current.delete(tabId);
        }
        reject(new Error("Ace browser tab did not become ready in time."));
      }, BROWSER_BRIDGE_TARGET_WAIT_MS);
    });
  };

  const resolveBridgeTarget = async (args: Record<string, unknown>) => {
    const tabId = readStringArgAny(args, ["tabId", "tab_id"]) ?? browserSession.activeTabId;
    const tab = browserSession.tabs.find((item) => item.id === tabId);
    if (!tab) {
      throw new Error("Ace browser tab was not found.");
    }
    if (isBrowserInternalTabUrl(tab.url)) {
      throw new Error("Ace browser tab is still on an internal page. Open a URL first.");
    }
    let handle = webviewHandlesRef.current.get(tab.id);
    if (!handle) {
      updateBrowserSession((current) => setActiveBrowserTab(current, tab.id));
      handle = await waitForWebviewHandle(tab.id);
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
  };

  const runBridgeRequest = async (
    request: BrowserBridgeRequest,
  ): Promise<Record<string, unknown>> => {
    const args = request.args as Record<string, unknown>;
    const operation = request.operation;
    const buildBridgeReadCacheKey = (tabId: string) =>
      `${tabId}:${operation}:${JSON.stringify(args)}`;
    const readCachedBridgeResult = (tabId: string): Record<string, unknown> | null => {
      const key = buildBridgeReadCacheKey(tabId);
      const cached = bridgeReadCacheRef.current.get(key);
      if (!cached) {
        return null;
      }
      if (Date.now() - cached.cachedAt > BROWSER_BRIDGE_READ_CACHE_TTL_MS) {
        bridgeReadCacheRef.current.delete(key);
        return null;
      }
      return cached.result;
    };
    const writeCachedBridgeResult = (tabId: string, result: Record<string, unknown>) => {
      bridgeReadCacheRef.current.set(buildBridgeReadCacheKey(tabId), {
        cachedAt: Date.now(),
        result,
      });
      return result;
    };
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
      clearBridgeReadCache(tab.id);
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
      clearBridgeReadCache(tab.id);
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
        browserTabCount: tabCount,
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
        const requestedIndex = readBrowserBridgeTabIndexArg(args, tabCount);
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
        const nextIndex = resolveNextBrowserTabIndex(currentIndex, tabCount, direction);
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
        clearBridgeReadCache();
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
        clearBridgeReadCache(tabId);
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
        clearBridgeReadCache();
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
          clearBridgeReadCache();
          openUrl(url, newTab === undefined ? undefined : { newTab });
          return { ok: true, url: normalizedUrl };
        }
        const tab = browserSession.tabs.find((item) => item.id === targetTabId);
        if (!tab) {
          throw new Error("Ace browser tab was not found.");
        }
        dismissAddressBarSuggestionOverlay();
        clearBridgeReadCache(targetTabId);
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
        const requestedWidth = readNumberArgAny(args, ["width", "viewportWidth", "viewport_width"]);
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
          if (activeTab) {
            clearBridgeReadCache(activeTab.id);
          }
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
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
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
          clearBridgeReadCache(tab.id);
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
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        const cached = readCachedBridgeResult(tab.id);
        if (cached) {
          return cached;
        }
        const domSnapshot = await handle.executeJavaScript(
          buildBrowserPlaywrightDomSnapshotScript(),
        );
        return writeCachedBridgeResult(tab.id, {
          domSnapshot,
          tab: {
            id: tab.id,
            ...snapshot,
          },
        });
      }
      case "dom_cua_get_visible_dom":
      case "dom_snapshot": {
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        const cached = readCachedBridgeResult(tab.id);
        if (cached) {
          return cached;
        }
        const dom = await handle.executeJavaScript(buildBrowserDomSnapshotScript());
        return writeCachedBridgeResult(tab.id, {
          dom,
          tab: {
            id: tab.id,
            ...snapshot,
          },
        });
      }
      case "cua_get_visible_screenshot":
      case "playwright_screenshot":
      case "screenshot": {
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        const cached = readCachedBridgeResult(tab.id);
        if (cached) {
          return cached;
        }
        const imageDataUrl = await handle.captureVisiblePage();
        const pageViewport = normalizePageViewportSize(
          await handle.executeJavaScript(BROWSER_VIEWPORT_SIZE_SCRIPT).catch(() => null),
        );
        return writeCachedBridgeResult(tab.id, {
          browserZoomFactor: handle.getZoomFactor(),
          coordinateSpace: "css-pixels",
          imageDataUrl,
          mimeType: "image/png",
          pageViewport,
          tab: {
            id: tab.id,
            ...snapshot,
          },
        });
      }
      case "cua_click":
      case "cua_double_click":
      case "cua_drag":
      case "cua_keypress":
      case "cua_move":
      case "cua_scroll":
      case "cua_type": {
        const action = operation.replace(/^cua_/u, "").replace("double_click", "double_click");
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        if (action === "keypress") {
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromArgs(
              action as BrowserAgentPointerEffect["type"],
              args,
            ),
          );
          await handle.pressKeys(readBrowserBridgeKeys(args));
          return { ok: true, tab: { id: tab.id, ...snapshot } };
        }
        await handle.animateAgentPointer(
          buildBrowserAgentPointerEffectFromArgs(action as BrowserAgentPointerEffect["type"], args),
        );
        const result = await handle.executeJavaScript(buildBrowserCuaActionScript(action, args));
        return { ok: true, result, tab: { id: tab.id, ...snapshot } };
      }
      case "dom_cua_click":
      case "dom_cua_double_click":
      case "dom_cua_keypress":
      case "dom_cua_scroll":
      case "dom_cua_type": {
        const action = operation.replace(/^dom_cua_/u, "");
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        const [target, result] = await Promise.all([
          handle.executeJavaScript(buildBrowserDomCuaTargetScript(action, args)),
          handle.executeJavaScript(buildBrowserDomCuaActionScript(action, args)),
        ]);
        await handle.animateAgentPointer(
          buildBrowserAgentPointerEffectFromResult(
            action as BrowserAgentPointerEffect["type"],
            target,
            args,
          ),
        );
        return { ok: true, result, tab: { id: tab.id, ...snapshot } };
      }
      case "click": {
        const selector = readStringArg(args, "selector");
        if (!selector) {
          throw new Error("click requires a selector argument.");
        }
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        const [target, action] = await Promise.all([
          handle.executeJavaScript(buildBrowserSelectorTargetScript(selector)),
          handle.executeJavaScript(buildBrowserClickScript(selector)),
        ]);
        await handle.animateAgentPointer(buildBrowserAgentPointerEffectFromResult("click", target));
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
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        const [target, action] = await Promise.all([
          handle.executeJavaScript(buildBrowserSelectorTargetScript(selector)),
          handle.executeJavaScript(buildBrowserFillScript(selector, value)),
        ]);
        await handle.animateAgentPointer(buildBrowserAgentPointerEffectFromResult("type", target));
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
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
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
          clearBridgeReadCache(tab.id);
          const target = await handle.executeJavaScript(buildBrowserLocatorTargetScript(args));
          await handle.animateAgentPointer(
            buildBrowserAgentPointerEffectFromResult(animatedAction, target, args),
          );
        }
        const result = await handle.executeJavaScript(
          buildBrowserLocatorActionScript(action, args),
        );
        if (
          action === "click" ||
          action === "dblclick" ||
          action === "fill" ||
          action === "press" ||
          action === "select_option" ||
          action === "set_checked"
        ) {
          clearBridgeReadCache(tab.id);
        }
        return { ok: true, result, tab: { id: tab.id, ...snapshot } };
      }
      case "playwright_wait_for_load_state": {
        const { handle, tab } = await resolveBridgeTarget(args);
        const timeoutMs = readTimeoutMs(args);
        return pollUntilResult({
          timeoutMs,
          intervalMs: 100,
          errorMessage: "Timed out waiting for browser load state.",
          readResult: () =>
            handle.getSnapshot()?.loading === false ? { ok: true as const, tabId: tab.id } : null,
        });
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
        const expectedUrlMatcher =
          expectedUrl.length > 0 ? new RegExp(escapeRegExp(expectedUrl)) : null;
        const { handle, tab } = await resolveBridgeTarget(args);
        const timeoutMs = readTimeoutMs(args);
        return pollUntilResult({
          timeoutMs,
          intervalMs: 100,
          errorMessage: "Timed out waiting for browser URL.",
          readResult: () => {
            const currentUrl = handle.getSnapshot()?.url ?? "";
            if (
              currentUrl === expectedUrl ||
              expectedUrlMatcher === null ||
              expectedUrlMatcher.test(currentUrl)
            ) {
              return { ok: true as const, tabId: tab.id, url: currentUrl };
            }
            return null;
          },
        });
      }
      case "tab_clipboard_read_text": {
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        const result = await handle.executeJavaScript(
          buildBrowserClipboardActionScript("read_text", args),
        );
        return { ok: true, result, tab: { id: tab.id, ...snapshot } };
      }
      case "tab_clipboard_write_text": {
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        const result = await handle.executeJavaScript(
          buildBrowserClipboardActionScript("write_text", args),
        );
        return { ok: true, result, tab: { id: tab.id, ...snapshot } };
      }
      case "tab_dev_logs": {
        const { handle, snapshot, tab } = await resolveBridgeTarget(args);
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
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.goBack();
        return { ok: true, tabId: tab.id };
      }
      case "navigate_tab_back": {
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.goBack();
        return { ok: true, tabId: tab.id };
      }
      case "forward": {
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.goForward();
        return { ok: true, tabId: tab.id };
      }
      case "navigate_tab_forward": {
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.goForward();
        return { ok: true, tabId: tab.id };
      }
      case "reload": {
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.reload();
        return { ok: true, tabId: tab.id };
      }
      case "navigate_tab_reload": {
        const { handle, tab } = await resolveBridgeTarget(args);
        clearBridgeReadCache(tab.id);
        handle.reload();
        return { ok: true, tabId: tab.id };
      }
      default:
        throw new Error(`Unsupported Ace browser operation: ${request.operation}`);
    }
  };

  const openDevTools = () => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.openDevTools();
  };

  const closeDevTools = () => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.closeDevTools();
  };

  const toggleDevTools = () => {
    if (!activeTab) return;
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (!handle) return;
    if (handle.isDevToolsOpen()) {
      handle.closeDevTools();
      return;
    }
    handle.openDevTools();
  };

  const selectDesignerTool = (tool: BrowserDesignerTool) => {
    setDesignerState((current) =>
      current.tool === tool && current.active
        ? current
        : {
            ...current,
            active: true,
            tool,
          },
    );
  };
  const setDesignerModeActive = (active: boolean) => {
    setDesignerState((current) =>
      current.active === active
        ? current
        : {
            ...current,
            active,
          },
    );
  };
  const toggleDesignerTool = (tool: BrowserDesignerTool) => {
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
  };
  const setDesignerPillPosition = (pillPosition: BrowserDesignerPillPosition | null) => {
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
  };

  const closeActiveTabEvent = useStableCallback(closeActiveTab);
  const clearAgentPointersEvent = useStableCallback(clearAgentPointers);
  const closeTabEvent = useStableCallback(closeTab);
  const closeDevToolsEvent = useStableCallback(closeDevTools);
  const findInPageEvent = useStableCallback(findInPage);
  const focusAddressBarEvent = useStableCallback(focusAddressBar);
  const goBackEvent = useStableCallback(goBack);
  const goForwardEvent = useStableCallback(goForward);
  const moveTabSelectionEvent = useStableCallback(moveTabSelection);
  const openDevToolsEvent = useStableCallback(openDevTools);
  const openNewTabEvent = useStableCallback(openNewTab);
  const activateTabEvent = useStableCallback(activateTab);
  const reorderTabsEvent = useStableCallback(reorderTabs);
  const openUrlEvent = useStableCallback(openUrl);
  const reloadEvent = useStableCallback(reload);
  const runBridgeRequestEvent = useStableCallback(runBridgeRequest);
  const setActiveTabByIndexEvent = useStableCallback(setActiveTabByIndex);
  const setDesignerModeActiveEvent = useStableCallback(setDesignerModeActive);
  const stopFindInPageEvent = useStableCallback(stopFindInPage);
  const toggleDesignerToolEvent = useStableCallback(toggleDesignerTool);
  const toggleDevToolsEvent = useStableCallback(toggleDevTools);
  const zoomInEvent = useStableCallback(zoomIn);
  const zoomOutEvent = useStableCallback(zoomOut);
  const zoomResetEvent = useStableCallback(zoomReset);
  const browserController = useMemo<InAppBrowserController>(
    () => ({
      activateTab: (tabId) => activateTabEvent(tabId),
      clearAgentPointers: () => clearAgentPointersEvent(),
      closeActiveTab: () => closeActiveTabEvent(),
      closeTab: (tabId) => closeTabEvent(tabId),
      closeDevTools: () => closeDevToolsEvent(),
      findInPage: (query, options) => findInPageEvent(query, options),
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
      stopFindInPage: () => stopFindInPageEvent(),
      toggleDesignerTool: (tool) => toggleDesignerToolEvent(tool),
      toggleDevTools: () => toggleDevToolsEvent(),
      zoomIn: () => zoomInEvent(),
      zoomOut: () => zoomOutEvent(),
      zoomReset: () => zoomResetEvent(),
    }),
    [
      activateTabEvent,
      clearAgentPointersEvent,
      closeActiveTabEvent,
      closeDevToolsEvent,
      closeTabEvent,
      findInPageEvent,
      focusAddressBarEvent,
      goBackEvent,
      goForwardEvent,
      moveTabSelectionEvent,
      openDevToolsEvent,
      openNewTabEvent,
      openUrlEvent,
      reloadEvent,
      reorderTabsEvent,
      runBridgeRequestEvent,
      setActiveTabByIndexEvent,
      setDesignerModeActiveEvent,
      stopFindInPageEvent,
      toggleDesignerToolEvent,
      toggleDevToolsEvent,
      zoomInEvent,
      zoomOutEvent,
      zoomResetEvent,
    ],
  );

  const repairBrowserStorage = async () => {
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
      setIsRepairingStorage(false);
      return;
    }
    setIsRepairingStorage(false);
  };

  const openActiveTabExternally = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    void api?.shell.openExternal(activeTab.url);
  };

  const openActiveTabInAuthWindow = () => {
    if (!activeTab || activeTabIsInternal) {
      return;
    }
    void (async () => {
      try {
        const opened = await api?.browser.openAuthWindow(activeTab.url);
        if (opened) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Sign-in window unavailable.",
          description: "This page could not be opened in a browser sign-in window.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Sign-in window unavailable.",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    })();
  };

  const handleAddressBarKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissAddressBarSuggestionOverlay();
      setSelectedSuggestionIndex(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target =
        showAddressBarSuggestions && addressBarSuggestions.length > 0
          ? resolveBrowserAddressBarEnterTarget({
              selectedSuggestionIndex,
              suggestions: addressBarSuggestions,
            })
          : { kind: "draft" as const };
      if (target.kind === "suggestion") {
        applySuggestion(target.suggestion);
      } else {
        openUrl(draftUrl);
      }
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
  };

  const handleBrowserKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
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
    if (key === "f") {
      event.preventDefault();
      event.stopPropagation();
      onFindInPageShortcut?.();
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
  };

  const registerWebviewHandle = (tabId: string, handle: BrowserTabHandle | null) => {
    clearBridgeReadCache(tabId);
    if (handle) {
      webviewHandlesRef.current.set(tabId, handle);
      const waiters = webviewHandleWaitersRef.current.get(tabId);
      if (waiters) {
        webviewHandleWaitersRef.current.delete(tabId);
        for (const waiter of waiters) {
          waiter(handle);
        }
      }
      return;
    }
    webviewHandlesRef.current.delete(tabId);
    lastRecordedBrowserHistoryUrlByTabRef.current.delete(tabId);
  };
  const hasWebContentsId = (webContentsId: number) =>
    browserSession.tabs.some(
      (tab) => webviewHandlesRef.current.get(tab.id)?.getWebContentsId() === webContentsId,
    );

  const handleTabSnapshotChange = (
    tabId: string,
    snapshot: BrowserTabSnapshot,
    options?: BrowserTabSnapshotOptions,
  ) => {
    clearBridgeReadCache(tabId);
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
  };

  const browserShellStyle: CSSProperties | undefined =
    mode === "full"
      ? {
          height: "100%",
          left: 0,
          top: 0,
          width: "100%",
        }
      : undefined;

  const browserStatusLabel = activeRuntime.devToolsOpen
    ? activeRuntime.loading
      ? "Inspecting · Loading"
      : "Inspecting"
    : activeRuntime.loading
      ? "Loading"
      : null;

  useEffect(() => {
    syncDraftUrlFromActiveTab({ activeTabIsInternal, activeTabUrl });
  }, [activeTabIsInternal, activeTabUrl, syncDraftUrlFromActiveTab]);

  useEffect(() => {
    initialAddressBarAutoFocusHandledRef.current = false;
  }, [browserSessionStorageKey]);

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
        browserTabCount: tabCount,
      })
    ) {
      return;
    }
    focusAddressBarEvent();
  }, [activeTabIsNewTab, focusAddressBarEvent, open, tabCount]);

  useEffect(() => {
    if (!window.desktopBridge?.onBrowserShortcutAction) {
      return;
    }
    return window.desktopBridge.onBrowserShortcutAction((action) => {
      if (!open || !active) {
        return;
      }
      switch (action) {
        case "back":
          goBackEvent();
          return;
        case "close-tab":
          closeActiveTabEvent();
          return;
        case "devtools":
          toggleDevToolsEvent();
          return;
        case "find-in-page":
          onFindInPageShortcut?.();
          return;
        case "designer-area-comment":
          toggleDesignerToolEvent("area-comment");
          return;
        case "designer-element-comment":
          toggleDesignerToolEvent("element-comment");
          return;
        case "focus-address-bar":
          focusAddressBarEvent();
          return;
        case "forward":
          goForwardEvent();
          return;
        case "new-tab":
          openNewTabEvent();
          return;
        case "next-tab":
          moveTabSelectionEvent(1);
          return;
        case "previous-tab":
          moveTabSelectionEvent(-1);
          return;
        case "reload":
          reloadEvent();
          return;
        case "right-panel-floating-chat-toggle":
          onToggleRightPanelFloatingChat?.();
          return;
        case "right-panel-fullscreen-toggle":
          onToggleRightPanelFullscreen?.();
          return;
        case "toggle-designer-mode":
          if (!designerModeEnabled || activeTabIsInternal) {
            return;
          }
          setDesignerModeActiveEvent(!designerState.active);
          return;
        default:
          if (action.startsWith("select-tab-")) {
            const index = Number.parseInt(action.slice("select-tab-".length), 10);
            if (Number.isInteger(index) && index >= 1) {
              setActiveTabByIndexEvent(index - 1);
            }
          }
      }
    });
  }, [
    activeTabIsInternal,
    closeActiveTabEvent,
    designerModeEnabled,
    designerState.active,
    focusAddressBarEvent,
    goBackEvent,
    goForwardEvent,
    moveTabSelectionEvent,
    onFindInPageShortcut,
    active,
    open,
    openNewTabEvent,
    onToggleRightPanelFloatingChat,
    onToggleRightPanelFullscreen,
    reloadEvent,
    setActiveTabByIndexEvent,
    setDesignerModeActiveEvent,
    toggleDesignerToolEvent,
    toggleDevToolsEvent,
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

  const clearBrowserContextMenuFallbackTimer = useEffectEvent(() => {
    if (browserContextMenuFallbackTimerRef.current !== null) {
      window.clearTimeout(browserContextMenuFallbackTimerRef.current);
      browserContextMenuFallbackTimerRef.current = null;
    }
  });

  useEffect(() => {
    return () => {
      clearBrowserContextMenuFallbackTimer();
    };
  }, []);

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
    findInPage,
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
    openActiveTabInAuthWindow,
    openDevTools,
    openNewTab,
    openUrl,
    reorderTabs,
    registerWebviewHandle,
    hasWebContentsId,
    reload,
    repairBrowserStorage,
    selectDesignerTool,
    selectSearchEngine: (engine: typeof browserSearchEngine) => {
      updateSettings({ browserSearchEngine: engine });
    },
    setDesignerModeActive,
    setDesignerPillPosition,
    stopFindInPage,
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
