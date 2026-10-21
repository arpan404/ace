import type { BrowserPageState, BrowserScreenshotSet, BrowserScreenshotSize } from "@ace/protocol";
import type { BrowserLogEntry } from "@ace/ui-core";
import type { AnnotationDriver } from "@/features/annotations/index.ts";

/*
 * The daemon services behind the panels, as the panels see them. `terminal/daemon-terminals.ts`
 * implements the terminal over `terminal.request` / `terminal.output` / `terminal.credit`, and
 * `preview/daemon-preview.ts` the browser relay and preview gateway over `browser.*` and
 * `preview.request`. The fake daemon serves the same messages, so both modes share one path.
 */

export type TerminalEvent =
  | { type: "data"; offset: number; endOffset: number; data: string; truncatedBefore: boolean }
  | { type: "resync"; oldestOffset: number; nextOffset: number }
  | { type: "exit"; code: number; nextOffset: number };
export interface TerminalInfo {
  id: string;
  threadId: string;
  name: string;
  exited: boolean;
}

/** PTYs owned by the daemon. Output survives client disconnects; attach replays from an offset. */
export interface TerminalSource {
  readonly link: "connected" | "disconnected";
  /** Changes whenever `list` or `link` would. */
  readonly version: number;
  subscribe(listener: () => void): () => void;
  /** The thread's terminals as last read; reading a thread for the first time fetches them. */
  list(threadId: string): readonly TerminalInfo[];
  /** The thread's terminals have been read from the daemon (until then `list` is empty). */
  listed(threadId: string): boolean;
  /** Read the thread's terminals again (one started elsewhere, such as a script run). */
  refresh(threadId: string): Promise<void>;
  open(threadId: string, cols: number, rows: number): Promise<TerminalInfo>;
  attach(id: string, fromOffset: number, listener: (event: TerminalEvent) => void): () => void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /**
   * A terminal outside any thread that this client was handed (a provider's sign-in terminal,
   * `provider.login.terminal`): its requests name no thread.
   */
  adopt?(id: string): void;
  /** End the shell. `threadId` is needed for a terminal this client hasn't listed yet. */
  close(id: string, threadId?: string): Promise<void>;
}

export interface BrowserView {
  threadId: string;
  /** The address of the tab the person views. */
  url: string;
  closed: boolean;
  /** Set while the browser backend is recovering or paused, with the daemon's reason. */
  status?: "ready" | "paused" | "recovering" | undefined;
  reason?: string | undefined;
  /** Where the page runs: the desktop app's own browser, or the daemon's headless Chromium. */
  backend?: "embedded" | "headless" | "user" | undefined;
  /** The page was reopened after its backend was lost; cookies and page state are gone. */
  pageStateLost?: boolean | undefined;
  loading?: boolean | undefined;
  loadError?: string | undefined;
  permissionDenied?: { origin: string; permission: string } | undefined;
  /** The thread's tabs, shared by the person and agents, by stable id (not by address). */
  tabs?: readonly BrowserTabView[] | undefined;
  /** The tab the person views, on every device. */
  activeTabId?: string | undefined;
  /** Files the page downloaded into this thread's quarantine. */
  downloads?: readonly BrowserDownloadView[] | undefined;
  /** An alert, confirm or prompt waiting for an answer, on whichever tab raised it. */
  pendingDialog?: BrowserDialogView | undefined;
  /** Set while a connection has annotate mode open on the page (ADR 0082). */
  annotation?: { owner: string } | undefined;
  /**
   * Optional page features the daemon supports, such as `annotate`; with `page-cursor` agents'
   * cursors are drawn in the page itself.
   */
  features?: readonly string[] | undefined;
  /** A recording of the shown tab runs, started by the person or an agent. */
  recording?: { by: BrowserActorView } | undefined;
}
export interface BrowserDialogView {
  dialogId: string;
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string | undefined;
}
/** Who opened or uses a tab: the person, an agent (by its agent id when known) or the page. */
export interface BrowserActorView {
  kind: "human" | "agent" | "page";
  agentId?: string | undefined;
}
export interface BrowserTabView {
  tabId: string;
  url: string;
  title: string;
  favicon?: string | undefined;
  loading?: boolean | undefined;
  /** A short name the agent gave the tab ("checkout"). */
  label?: string | undefined;
  openedBy?: BrowserActorView | undefined;
  /** The agent working in this tab now; the strip marks it with the agent cursor. */
  inUse?: BrowserActorView | undefined;
  /** Where that agent last pointed, in the tab's CSS pixels (`sequence` rises each time). */
  pointer?: { x: number; y: number; sequence: number } | undefined;
  /** "Keep agents out of this tab": agents can neither read nor drive it. */
  private?: boolean | undefined;
  pendingDialog?: BrowserDialogView | undefined;
  /** Page zoom (1 is 100%); absent at 100%. */
  zoom?: number | undefined;
  /** The device the tab emulates and who set it; absent: it follows the pane. */
  emulation?: (Emulation & { by: "human" | "agent" }) | undefined;
  /** The page opened a file picker; the person picks files on this device. */
  fileChooser?: { chooserId: string; tabId: string; multiple: boolean } | undefined;
  /** The page plays sound; `muted` says whether it is heard. */
  audible?: boolean | undefined;
  muted?: boolean | undefined;
  /** A site's sign-in prompt holding the page; only the person answers it. */
  pendingAuth?: BrowserSignInView | undefined;
  /** The page wasn't opened: its certificate isn't trusted. The person may proceed anyway. */
  certificateError?: { url: string; error: string } | undefined;
  /** Audio or video with sound plays in this tab now. */
  playing?: boolean | undefined;
  /** Whether Back and Forward lead anywhere, as the daemon keeps them current. */
  canGoBack?: boolean | undefined;
  canGoForward?: boolean | undefined;
}
export interface BrowserSignInView {
  authId: string;
  tabId: string;
  origin: string;
  realm?: string | undefined;
}
export interface BrowserDownloadView {
  downloadId: string;
  tabId: string;
  filename: string;
  bytes: number;
  mimeType: string;
  flags: readonly ("executable" | "archive")[];
  state: "pending" | "complete" | "denied" | "failed" | "too_large";
  /** Where the file is on the daemon's machine, once complete. */
  path?: string | undefined;
}
/** One extension a browser engine runs (BrowserCommand `extensions`). */
export interface BrowserExtensionView {
  id: string;
  name: string;
  version?: string | undefined;
  enabled: boolean;
}
/**
 * One line of a tab's console or network log, as agents read it (BrowserCommand `logs`). A
 * network entry is a response (`status`) or a failure; `bytes` and `durationMs` arrive once the
 * request finishes. `at` is when the daemon recorded it, in milliseconds.
 */
export type { BrowserLogEntry };
/** A device the page can pretend to be (BrowserCommand `emulate`). */
export interface Emulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string | undefined;
}
/** The person's own page commands (zoom, print, screenshot, page source, clear data). */
export type PageToolCommand =
  | { action: "zoom"; factor: number }
  | { action: "pdf"; landscape: boolean; printBackground: boolean }
  | { action: "screenshot"; fullPage: boolean }
  | { action: "page_source" }
  | { action: "clear_data" }
  | { action: "context_target"; x: number; y: number }
  | { action: "image_data"; url: string };
/**
 * A tab's live picture (ADR 0088): the newest decoded video picture, drawn on a canvas. The
 * object stays the same while the page's size and the picture's pixels do, so views render only
 * when those change; each newer picture is announced through `subscribe`, outside React.
 */
export interface ScreenFrame {
  /** The newest picture's chunk sequence. */
  readonly sequence: number;
  /** CSS pixels of the page: input coordinates map to these. */
  readonly width: number;
  readonly height: number;
  /** The picture's own pixels: the canvas bitmap's size. */
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** Draws the newest picture over the whole canvas; false once it was released. */
  draw(context: CanvasRenderingContext2D, width: number, height: number): boolean;
  /** Calls `listener` whenever a newer picture replaces the one shown; the result stops it. */
  subscribe(listener: () => void): () => void;
}
export interface PreviewServer {
  port: number;
  origin?: string | undefined;
  name?: string | undefined;
  source: "listener" | "terminal" | "launch";
}
/**
 * A local dev server the daemon detected for a thread: started from its terminals or agent
 * shells, or running in its project, and answering HTTP on loopback. `url` is the address the
 * server printed (or `http://localhost:<port>/`); `iconUrl` is a small image, usually a
 * `data:` URI; `source` says whether its address was printed ("terminal") or its port was
 * found listening ("listener").
 */
export interface PreviewSuggestion {
  port: number;
  url: string;
  title?: string | undefined;
  iconUrl?: string | undefined;
  source: "listener" | "terminal";
}
/**
 * A single-use address that signs a frame or browser in to a dev server's preview, and how
 * long the session it opens lasts.
 */
export interface PreviewLink {
  url: string;
  sessionMs: number;
}
export type ForwardedInput =
  | {
      kind: "mouse";
      event: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
      /** Buttons held, as a mask: left 1, right 2, middle 4. */
      buttons?: number;
      clickCount?: number;
      /** Keys held: Alt 1, Ctrl 2, Meta 4, Shift 8. */
      modifiers?: number;
    }
  | {
      kind: "key";
      event: "keyDown" | "keyUp" | "char";
      key: string;
      text?: string;
      code?: string;
      modifiers?: number;
    }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      kind: "touch";
      event: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      /** Every finger down, in page pixels; `id` (0–9) stays with its finger. */
      points: { x: number; y: number; id: number }[];
    }
  /** IME text being composed, shown marked in the page's field; empty cancels it. */
  | { kind: "ime"; text: string; selectionStart: number; selectionEnd: number }
  /** The person's choice in the page's open picker; without values it is dismissed. */
  | { kind: "pick"; pickerId: string; values?: readonly string[] };

/**
 * What a remote view draws over a tab's pixels: the focused field (where a phone's keyboard
 * types), the picker the page opened, the cursor shape and a `title` tooltip. Boxes are in the
 * tab's CSS pixels, the same space as the frame and forwarded input.
 */
export type BrowserPageView = BrowserPageState;

/** How far the daemon's Chromium download has got (`browser.download.progress`). */
export interface BrowserDownload {
  phase: "downloading" | "verifying" | "extracting";
  /** 0–1, when the daemon knows the size. */
  fraction: number | undefined;
}

export interface PreviewSource {
  /** Retire this client owner and release its cached frames and subscriptions. */
  dispose(): void;
  /** Bumps on every change, to any thread. */
  readonly version: number;
  /**
   * Every change, or with `threadId` only that thread's (its browser, frame and dev servers)
   * plus those that concern every thread (the Chromium download, the preview gateway).
   */
  subscribe(listener: () => void, threadId?: string): () => void;
  /**
   * Follow a thread's browser and dev servers while a view shows them: subscribes to frames
   * (retrying until a browser opens) and reads the dev servers. Call the result to stop.
   */
  watch(threadId: string): () => void;
  view(threadId: string): BrowserView | undefined;
  /**
   * The shown tab's live picture once its video decodes; undefined before the first keyframe
   * of a fresh view. Kept through a reconnect or a pause, so the last picture stays meanwhile.
   */
  frame(threadId: string): ScreenFrame | undefined;
  /**
   * Whether this client decodes any codec the daemon encodes live pages in (WebCodecs'
   * `VideoDecoder`); undefined while it is still being asked. A page shows only as video.
   */
  decodesVideo?(): boolean | undefined;
  /**
   * A tab's last picture from when it was the shown one (the video follows the shown tab), for
   * split view's other half; undefined when this client never saw it.
   */
  still?(threadId: string, tabId: string): ScreenFrame | undefined;
  servers(threadId: string): readonly PreviewServer[];
  /**
   * The thread's detected dev servers, printed ones first. Kept current while `watch(threadId)`
   * holds; each change notifies `subscribe` listeners for the thread. Empty before the first
   * read and from a daemon that doesn't detect servers.
   */
  suggestions(threadId: string): readonly PreviewSuggestion[];
  /**
   * Open a browser for the thread, for a person to drive or an agent to pick up. The daemon's
   * first browser downloads Chromium, which can take minutes; `download()` reports it meanwhile.
   */
  open(threadId: string, workspaceId: string): Promise<BrowserView | undefined>;
  /** The daemon's Chromium download while one is in progress. */
  download(): BrowserDownload | undefined;
  /** False once the daemon says it runs no preview gateway, so ports can't be previewed. */
  canForward(): boolean;
  /** Preview a dev server listening on `port` through the daemon's preview gateway. */
  forward(threadId: string, port: number): Promise<void>;
  /** Stop previewing it; the server itself keeps running. */
  unforward(threadId: string, port: number): Promise<void>;
  /**
   * A fresh sign-in link for a previewed port; rejects with the daemon's refusal code
   * (`forbidden`, `preview_not_found`, …). Each link works once, so every load asks again.
   */
  link(threadId: string, port: number): Promise<PreviewLink>;
  /**
   * Navigate a tab as the person (BrowserCommand `navigate`): the tab named, else the one shown.
   * Resolves with the address the page reached; rejects with the daemon's reason (a Chromium
   * net error, an origin awaiting approval).
   */
  navigate(threadId: string, url: string, tabId?: string): Promise<string>;
  navigateHistory?(
    threadId: string,
    direction: "back" | "forward" | "reload" | "stop",
    tabId?: string,
  ): Promise<void>;
  findText?(threadId: string, text: string, forward: boolean, tabId?: string): Promise<unknown>;
  /** Make a tab a device's size and kind (`emulate`). */
  emulate(threadId: string, emulation: Emulation, tabId?: string): Promise<void>;
  /** Close the thread's browser and all its tabs (agents can open it again). */
  close(threadId: string): Promise<void>;
  /** A new tab, shown at once; at `url` when given. Resolves with its id. */
  openTab(threadId: string, url?: string): Promise<string>;
  /** Show this tab to the person (on every device); agents keep working where they are. */
  selectTab(threadId: string, tabId: string): Promise<void>;
  /** The thread's open tabs, read once (empty while it has no browser). */
  listTabs?(threadId: string): Promise<readonly BrowserTabView[]>;
  /** Close a tab; closing the last one closes the browser. */
  closeTab(threadId: string, tabId: string): Promise<void>;
  /** "Keep agents out of this tab", or let them back in. */
  keepPrivate(threadId: string, tabId: string, value: boolean): Promise<void>;
  /** One of the person's page commands in a tab (the shown one unless named). */
  pageTool?(threadId: string, command: PageToolCommand, tabId?: string): Promise<unknown>;
  /**
   * The tab laid out at each size and captured there, then restored (`screenshot` with
   * `sizes`). The daemon keeps each as a full-size PNG in the thread; the result holds previews.
   */
  screenshotSizes?(
    threadId: string,
    tabId: string,
    sizes: readonly BrowserScreenshotSize[],
    fullPage: boolean,
  ): Promise<BrowserScreenshotSet>;
  /** A tab's console and network log, oldest first (the same entries agents read). */
  logs?(threadId: string, tabId: string): Promise<readonly BrowserLogEntry[]>;
  /** Extensions the tab's engine runs, as its backend reports them (read-only). */
  extensions?(threadId: string): Promise<readonly BrowserExtensionView[]>;
  /** The person's own input; it lands at once, whoever else works in the tab. */
  input(threadId: string, input: ForwardedInput, tabId?: string): void | Promise<void>;
  /**
   * A tab's page state as the daemon last reported it (`browser.page`); undefined from a daemon
   * or backend that doesn't report one. Changes notify `subscribe` listeners for the thread.
   */
  page?(threadId: string, tabId: string): BrowserPageView | undefined;
  /** Annotate mode on the page (ADR 0082); absent where the client can't drive it. */
  annotate?: AnnotationDriver | undefined;
  /** Read the current page selection for local copy and cut. */
  selection?(threadId: string, tabId?: string): Promise<string>;
  nativeShown?(threadId: string, shown: boolean): void;
  capture?(threadId: string, width: number, height: number, devicePixelRatio: number): void;
  /** The person's accent for agents' cursors drawn in the page (`fill`, `outline`: #RRGGBB). */
  cursorStyle?(threadId: string, style: { fill: string; outline: string }): void;
  /** Stop the recording that runs in the thread's browser; its file joins the thread. */
  stopRecording?(threadId: string): Promise<void>;
  /**
   * Whether the page's sound plays here (ADR 0088, Audio): false until the person unmutes, on
   * every device. Undefined where this client can't play it.
   */
  audio?(threadId: string): boolean | undefined;
  /**
   * The person's speaker toggle. Call it from their click or tap: phone browsers only start
   * sound inside a user gesture. The daemon sends sound only while a viewer has it on.
   */
  setAudio?(threadId: string, on: boolean): void;
  /**
   * Size the page to the pane in CSS pixels (100–4096). `touch`: the pane is on a touch screen,
   * so the page lays out as a mobile one and gets touch events. The page renders as sharp as
   * the pane's screen (`devicePixelRatio`) where the browser can.
   */
  resize(
    threadId: string,
    width: number,
    height: number,
    touch?: boolean,
    devicePixelRatio?: number,
  ): void;
}
