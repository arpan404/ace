import type { BrowserSearchEngine } from "@ace/contracts/settings";

import type { BrowserSuggestion } from "~/lib/browser/history";

export const IN_APP_BROWSER_PARTITION = "persist:ace-browser";
export const PIP_MARGIN_PX = 16;
export const MIN_PIP_WIDTH_PX = 320;
export const MIN_PIP_HEIGHT_PX = 216;
export const DEFAULT_PIP_WIDTH_PX = 440;
export const DEFAULT_PIP_HEIGHT_PX = 280;

export type BrowserWebviewMouseWheelInputEvent = {
  type: "mouseWheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  canScroll?: boolean;
};

export type BrowserWebviewKeyboardInputEvent = {
  type: "keyDown" | "keyUp";
  keyCode: string;
  modifiers?: Array<"shift" | "control" | "alt" | "meta">;
};

export const BROWSER_SEARCH_ENGINE_OPTIONS: Array<{
  label: string;
  value: BrowserSearchEngine;
}> = [
  { label: "DuckDuckGo", value: "duckduckgo" },
  { label: "Google", value: "google" },
  { label: "Brave Search", value: "brave" },
  { label: "Startpage", value: "startpage" },
];

export type BrowserWebview = HTMLElement & {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  capturePage?: (rect?: BrowserDesignSelectionRect) => Promise<BrowserCapturedImage>;
  closeDevTools: () => void;
  executeJavaScript?: <T = unknown>(code: string, userGesture?: boolean) => Promise<T>;
  getTitle: () => string;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpened: () => boolean;
  isLoading: () => boolean;
  loadURL: (url: string) => Promise<void>;
  openDevTools: (options?: { mode?: "detach" | "left" | "right" | "bottom" | "undocked" }) => void;
  reload: () => void;
  sendInputEvent?: (
    event: BrowserWebviewMouseWheelInputEvent | BrowserWebviewKeyboardInputEvent,
  ) => void;
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
  stop: () => void;
};

export type BrowserCapturedImage = {
  toDataURL: () => string;
};

export type BrowserDesignSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserAgentPointerPoint = {
  x: number;
  y: number;
};

export type BrowserAgentPointerEffect = {
  path?: BrowserAgentPointerPoint[];
  scrollX?: number;
  scrollY?: number;
  targetRect?: BrowserDesignSelectionRect;
  type: "click" | "double_click" | "drag" | "keypress" | "move" | "scroll" | "type";
  x?: number;
  y?: number;
};

export type BrowserDesignElementDescriptor = {
  tagName: string | null;
  id: string | null;
  className: string | null;
  selector: string | null;
  textSnippet: string | null;
  htmlSnippet: string | null;
};

export type BrowserDesignCaptureResult = {
  requestId: string;
  selection: BrowserDesignSelectionRect;
  imageDataUrl: string;
  imageMimeType: string;
  imageSizeBytes: number;
  targetElement: BrowserDesignElementDescriptor | null;
  mainContainer: BrowserDesignElementDescriptor | null;
};

export type BrowserDesignCaptureSubmission = BrowserDesignCaptureResult & {
  instructions: string;
};

export type BrowserDesignRequestSubmission = BrowserDesignCaptureSubmission & {
  pageUrl: string;
  pagePath: string;
};

export type BrowserTabRuntimeState = {
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen: boolean;
  loading: boolean;
};

export type BrowserTabSnapshot = BrowserTabRuntimeState & {
  title: string;
  url: string;
};

export type BrowserTabSnapshotOptions = {
  persistTab?: boolean;
  recordHistory?: boolean;
};

export type BrowserConsoleLogEntry = {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: string;
  timestamp: string;
  url?: string;
};

export type BrowserTabHandle = {
  animateAgentPointer: (effect: BrowserAgentPointerEffect) => Promise<void>;
  captureVisiblePage: () => Promise<string>;
  closeDevTools: () => void;
  executeJavaScript: <T = unknown>(code: string) => Promise<T>;
  getZoomFactor: () => number;
  getSnapshot: () => BrowserTabSnapshot | null;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpen: () => boolean;
  navigate: (url: string) => void;
  openDevTools: () => void;
  readConsoleLogs: (options?: {
    filter?: string;
    levels?: Array<BrowserConsoleLogEntry["level"] | "warning">;
    limit?: number;
  }) => BrowserConsoleLogEntry[];
  reload: () => void;
  pressKeys: (keys: ReadonlyArray<string>) => Promise<void>;
  setZoomFactor: (factor: number) => void;
  stop: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
};

export type BrowserWebviewContextMenuAction =
  | "back"
  | "copy-address"
  | "devtools"
  | "forward"
  | "new-tab"
  | "open-external"
  | "reload";

export type BrowserTabContextMenuAction =
  | "close"
  | "close-others"
  | "close-right"
  | "copy-address"
  | "duplicate"
  | "move-left"
  | "move-right"
  | "new-tab"
  | "open-external"
  | "pin-page"
  | "reload"
  | "unpin-page";

export const DEFAULT_BROWSER_TAB_RUNTIME_STATE: BrowserTabRuntimeState = {
  canGoBack: false,
  canGoForward: false,
  devToolsOpen: false,
  loading: false,
};

export function resolveSuggestionKindLabel(kind: BrowserSuggestion["kind"]): string {
  switch (kind) {
    case "history":
      return "History";
    case "home":
      return "Home";
    case "navigate":
      return "Address";
    case "search":
      return "Search";
    case "tab":
      return "Tab";
    default:
      return "Suggestion";
  }
}
