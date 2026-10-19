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
  /** The folder ace's Chrome saves finished downloads in, when the person chose one. */
  saveFolder?(): Promise<string | undefined>;
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
  /**
   * Whether a `beforeunload` prompt on this tab may be accepted without asking anyone: an
   * agent's command is leaving a page the person has not used since it loaded. Otherwise the
   * prompt is the person's to answer (ADR 0067, "Leaving a page the person was editing").
   */
  leaveUnasked?(tabId?: string): boolean;
  /** The person used a tab directly, in a view the daemon does not route (the desktop's). */
  humanInput?(tabId?: string): void;
  navigation(tabId?: string): void;
  /** The page called `window.print()` and no print dialog showed for it (ADR 0086). */
  print?(tabId?: string): void;
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
  /**
   * The person's answer to a site's sign-in prompt (the tab's `pending_auth`); omitted
   * credentials cancel it. A backend whose engine prompts the person itself has none.
   */
  answerAuth?(
    tabId: string,
    authId: string,
    credentials?: { username: string; password: string },
  ): Promise<void>;
  /**
   * The person proceeds past the tab's certificate error to `url`, for that origin and
   * certificate while the engine runs. Only the person's own request reaches this.
   */
  proceedCertificate?(tabId: string, url: string): Promise<void>;
  /**
   * The person's files for the tab's open file picker (`file_chooser`), as local paths; none
   * cancels it.
   */
  chooseFiles?(tabId: string, chooserId: string, paths: readonly string[]): Promise<void>;
  /** The person turns a tab's sound off or on (its `muted`). */
  mute?(tabId: string, muted: boolean): Promise<void>;
  page?(tabId: string): BrowserBackendPage;
  /** Drops an idle tab's page, keeping the tab listed at its address (ace's Chrome only). */
  discard?(tabId: string): Promise<void>;
  /** Reopens a discarded tab at its address, with the same id. */
  revive?(tabId: string): Promise<void>;
}
/** One page's surface. Everything here acts on that page only. */
export interface BrowserBackendPage {
  readonly cdp: BrowserCdp;
  /**
   * A tab the person shared from their own Chrome that no command has used yet: any CDP call
   * claims it, so nothing may watch it before then (ADR 0084).
   */
  unclaimed?(): boolean;
  findText?(text: string, forward: boolean): Promise<unknown>;
  pageStatus?(): {
    loading: boolean;
    loadError?: string | undefined;
    permissionDenied?: { origin: string; permission: string } | undefined;
  };
  networkBody?(requestId: string): Promise<unknown>;
  /**
   * Ids of this page's network requests still in flight, for network-idle waits; streams the
   * page keeps open while it lives (EventSource, event streams, sockets) are left out.
   */
  networkPending?(): readonly string[];
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
   * Take a device's size and scale (`emulate`) in a way the backend keeps with its own sizing
   * and zoom. Absent: the page is resized, then given the device metrics over CDP.
   */
  emulate?(device: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
  }): Promise<void>;
  /** Page zoom (1 is 100%), as a browser's zoom. Absent: the backend cannot zoom. */
  zoom?(factor: number): Promise<void>;
  /** Clear cookies, cache and site storage of the page's profile. Absent: not supported. */
  clearData?(): Promise<void>;
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
  /**
   * Checks the engine is alive (after the computer woke from sleep); resolves to whether it
   * is. A dead one is reported through the open request's `lost`, or restarted with its tabs,
   * as the backend recovers.
   */
  ping?(): Promise<boolean>;
  /** Agent-visible extensions, read-only. */
  extensions?(): Promise<{ id: string; name: string; version?: string; enabled: boolean }[]>;
  close(): Promise<void>;
}
export interface BrowserBackend {
  /** `user`: the person's own browser through the ace extension (ADR 0084). */
  readonly kind: "embedded" | "headless" | "user";
  open(request: BackendOpen): Promise<BrowserBackendSession>;
}
