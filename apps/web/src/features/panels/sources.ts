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
  controller: "agent" | "human" | "none";
  owner?: string | undefined;
  url: string;
  closed: boolean;
  /** Set while the browser backend is recovering or paused, with the daemon's reason. */
  status?: "ready" | "paused" | "recovering" | undefined;
  reason?: string | undefined;
  /** Where the page runs: the desktop app's own browser, or the daemon's headless Chromium. */
  backend?: "embedded" | "headless" | undefined;
  /** The page was reopened after its backend was lost; cookies and page state are gone. */
  pageStateLost?: boolean | undefined;
  /** The agent's tabs in this thread's browser, by stable id (not by address). */
  tabs?: readonly BrowserTabView[] | undefined;
  activeTabId?: string | undefined;
  /** Files the page downloaded into this thread's quarantine. */
  downloads?: readonly BrowserDownloadView[] | undefined;
  /** An alert, confirm or prompt waiting for an answer, on whichever tab raised it. */
  pendingDialog?: BrowserDialogView | undefined;
  /** "private": a person holds the page and agents can't see or read it. */
  takeoverMode?: "shared" | "private" | undefined;
}
export interface BrowserDialogView {
  dialogId: string;
  tabId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string | undefined;
}
export interface BrowserTabView {
  tabId: string;
  url: string;
  title: string;
  pendingDialog?: BrowserDialogView | undefined;
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
/** A device the page can pretend to be (BrowserCommand `emulate`). */
export interface Emulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
}
export interface ScreenFrame {
  sequence: number;
  src: string;
  width: number;
  height: number;
}
export interface PreviewServer {
  port: number;
  origin?: string | undefined;
  name?: string | undefined;
  source: "listener" | "terminal" | "launch";
}
export type ForwardedInput =
  | {
      kind: "mouse";
      event: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
    }
  | {
      kind: "key";
      event: "keyDown" | "keyUp" | "char";
      key: string;
      text?: string;
      code?: string;
      modifiers?: number;
    }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number };

/** The agent-driven browser (live view, take-over) and detected dev servers of a thread. */
/** How far the daemon's Chromium download has got (`browser.download.progress`). */
export interface BrowserDownload {
  phase: "downloading" | "verifying" | "extracting";
  /** 0–1, when the daemon knows the size. */
  fraction: number | undefined;
}

export interface PreviewSource {
  /** Bumps on every change, to any thread. */
  readonly version: number;
  /**
   * Every change, or with `threadId` only that thread's (its browser, frame and dev servers)
   * plus those that concern every thread (the Chromium download, the preview gateway).
   */
  subscribe(listener: () => void, threadId?: string): () => void;
  /**
   * Follow a thread's browser and dev servers while a view shows them: subscribes to frames
   * (retrying until a browser opens) and reads the dev servers. Call the result to stop; a
   * browser this client took control of is handed back to the agent.
   */
  watch(threadId: string): () => void;
  view(threadId: string): BrowserView | undefined;
  frame(threadId: string): ScreenFrame | undefined;
  servers(threadId: string): readonly PreviewServer[];
  /**
   * Open a browser for the thread, for a person to drive or an agent to pick up. The daemon's
   * first browser downloads Chromium, which can take minutes; `download()` reports it meanwhile.
   */
  open(threadId: string, workspaceId: string): Promise<void>;
  /** The daemon's Chromium download while one is in progress. */
  download(): BrowserDownload | undefined;
  /** False once the daemon says it runs no preview gateway, so ports can't be previewed. */
  canForward(): boolean;
  /** Preview a dev server listening on `port` through the daemon's preview gateway. */
  forward(threadId: string, port: number): Promise<void>;
  /** Stop previewing it; the server itself keeps running. */
  unforward(threadId: string, port: number): Promise<void>;
  /**
   * Navigate the page, as the person holding control (BrowserCommand `navigate`). Resolves
   * with the address the page reached; rejects with the daemon's reason (a Chromium net error,
   * an origin awaiting approval, control held elsewhere).
   */
  navigate(threadId: string, url: string): Promise<string>;
  navigationHistory?(threadId: string): Promise<{ back: boolean; forward: boolean }>;
  navigateHistory?(threadId: string, direction: "back" | "forward" | "reload"): Promise<void>;
  findText?(threadId: string, text: string, forward: boolean): Promise<unknown>;
  /** Make the page a device's size and kind (`emulate`); needs control like navigation. */
  emulate(threadId: string, emulation: Emulation): Promise<void>;
  /** Close the thread's page (agents can open it again). */
  close(threadId: string): Promise<void>;
  /** Take control; `private` also hides the page from agents until you hand it back. */
  takeover(threadId: string, mode?: "shared" | "private"): Promise<void>;
  handback(threadId: string): Promise<void>;
  /**
   * The daemon connection through which this client holds the thread's page, while the page's
   * current owner is that connection; undefined when it doesn't hold it (another device may).
   */
  heldAs(threadId: string): string | undefined;
  input(threadId: string, input: ForwardedInput): void;
  /** Size the page's viewport to the pane, in CSS pixels (BrowserCommand `resize`, 100–4096). */
  capture?(threadId: string, width: number, height: number, devicePixelRatio: number): void;
  resize(threadId: string, width: number, height: number): void;
}
