import type { BrowserOpen, BrowserTab, BrowserDownload, BrowserDialog } from "@ace/protocol";

/** Opaque CDP results are parsed by their owning operation before use. */
export interface BrowserCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): unknown;
  off(method: string, listener: (params: unknown) => void): unknown;
}
export interface BackendLog {
  /** The tab that logged the entry, when the backend knows it. */
  tabId?: string;
  requestId?: string;
  url?: string;
  status?: number;
  /** A network request's HTTP method. */
  method?: string;
  /** Bytes a finished request received over the network. */
  bytes?: number;
  /** From the request being sent to it finishing or failing. */
  durationMs?: number;
  kind: "console" | "network";
  /**
   * `loaded` is not an entry of its own: it completes the `response` entry with the same
   * `requestId` with `bytes` and `durationMs` once the body has arrived.
   */
  type: string;
  text: string;
}
/** A tab to bring back when a thread's browser reopens, such as after a daemon restart. */
export interface BackendRestoreTab {
  tabId: string;
  url: string;
}
export interface BackendOpen {
  options: BrowserOpen;
  id?(): string;
  reserveTab?(): () => void;
  /**
   * Tabs to recreate with these ids at these URLs, in order. A backend that cannot choose tab
   * ids (the desktop's views) ignores it; the thread browser then keeps what the backend reports.
   */
  restoreTabs?: readonly BackendRestoreTab[];
  /** Most tabs one thread may hold in this backend, popups included. */
  maxTabs?: number;
  changed?(): void;
  downloadDir?: string;
  maxDownloadBytes?: number;
  downloadAllowed?(url: string): Promise<boolean>;
  artifact?(artifact: import("@ace/protocol").BrowserArtifact): void | Promise<void>;
  profileDir: string;
  signal: AbortSignal;
  allowed(url: string, context?: { navigation?: boolean; human?: boolean }): Promise<boolean>;
  /** A page event submits navigation through the session owner before asking for approval. */
  popup?(url: string, target: PopupTarget): Promise<void>;
  /** Whether work without its own initiator (a page's own navigation) counts as the person's. */
  initiator?(): boolean;
  /** The person used a tab directly, in a view the daemon does not route (the desktop's). */
  humanInput?(tabId?: string): void;
  navigation(tabId?: string): void;
  /** A renderer (with `tabId`) or the whole browser (without) came back; re-arm its pages. */
  restarted?(tabId?: string): void;
  log(entry: BackendLog): void;
  lost(reason: string): void;
  /** Version 1 backends deny natively before reporting these hooks. */
  permissionDenied?(request: { origin: string; permission: string }): void;
  downloadDenied?(request: { url: string; suggestedFilename: string }): void;
}
/** The page a popup asked to load in place of the one that opened it. */
export interface PopupTarget {
  /** The opener's tab; the navigation runs in that tab's queue. */
  tabId?: string;
  current(): boolean;
  navigate(): Promise<void>;
}
/**
 * The tabs of one thread's browser. Every backend reports a list and the tab the person is shown
 * (`active`). Multi-tab backends also hand out each tab's own page (`page`), so commands on
 * different tabs never share or switch a page; a backend without `page` has one usable page, the
 * active one.
 */
export interface BrowserBackendTabs {
  list(): BrowserTab[];
  /** The tab shown to the person. Agent commands never change it. */
  active(): string;
  /**
   * Opens a tab and returns its id. `background` leaves the shown tab alone. A backend that
   * cannot open another tab returns the id of a tab it already has.
   */
  open(options?: { background?: boolean }): Promise<string>;
  /** Shows this tab to the person. */
  switch(tabId: string): Promise<void>;
  close(tabId: string): Promise<void>;
  dialog(): BrowserDialog | undefined;
  answer(dialogId: string, accept: boolean, promptText?: string): Promise<void>;
  /**
   * What the tabs downloaded. A backend without it cannot see downloads (the person's own
   * browser saves them itself, ADR 0084): asking for them fails at once with `not_supported`.
   */
  downloads?(): BrowserDownload[];
  /**
   * The tab whose page opened this one (a popup the backend adopted as a tab of its own). The
   * new tab counts as opened by whoever drove its opener.
   */
  opener?(tabId: string): string | undefined;
  page?(tabId: string): BrowserBackendPage;
}
/** One page's surface. Everything here acts on that page only. */
export interface BrowserBackendPage {
  readonly cdp: BrowserCdp;
  findText?(text: string, forward: boolean): Promise<unknown>;
  pageStatus?(): {
    loading: boolean;
    loadError?: string | undefined;
    permissionDenied?: { origin: string; permission: string } | undefined;
  };
  networkBody?(requestId: string): Promise<unknown>;
  frames?(): Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]>;
  url(): string;
  navigate(url: string, timeout: number, signal?: AbortSignal): Promise<void>;
  click(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  press(key: string): Promise<void>;
  wheel(x: number, y: number): Promise<void>;
  screenshot(format: "png" | "jpeg"): Promise<Buffer>;
  resize(width: number, height: number): Promise<void>;
  viewport(): { width: number; height: number };
  media(colorScheme: "light" | "dark" | "no-preference"): Promise<void>;
  /**
   * Why the page's renderer is down, while its backend has stopped bringing it back on its own
   * (the desktop after repeated crashes, ADR 0085). Only a navigation or a reload revives it.
   */
  crashed?(): string | undefined;
}
/** A thread's browser in one backend; as a page it is the active tab. */
export interface BrowserBackendSession extends BrowserBackendPage {
  tabs?: BrowserBackendTabs;
  /**
   * The backend handed back the thread's pages it kept through a lost link (a desktop
   * re-adopting its views, ADR 0085): their documents and state survived.
   */
  readonly adopted?: boolean;
  privateMode?(enabled: boolean): void;
  /**
   * An agent started or stopped using this tab. Optional: a backend may treat agent-used tabs
   * differently (the desktop intercepts file choosers and keeps an unseen view rendering).
   */
  agentUse?(tabId: string, active: boolean): Promise<void>;
  /** Agent-visible extensions, read-only. */
  extensions?(): Promise<{ id: string; name: string; version?: string; enabled: boolean }[]>;
  close(): Promise<void>;
}
export interface BrowserBackend {
  /** `user`: the person's own browser through the ace extension (ADR 0084). */
  readonly kind: "embedded" | "headless" | "user";
  open(request: BackendOpen): Promise<BrowserBackendSession>;
}
