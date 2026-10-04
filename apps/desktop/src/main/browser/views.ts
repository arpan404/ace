import { createHash } from "node:crypto";
import {
  WebContentsView,
  session as sessions,
  type BaseWindow,
  type Session,
  type WebContents,
} from "electron";
import type { BrowserOpen } from "@ace/protocol";
import type { BrowserPlacement } from "../../shared/contract.ts";
import type { ViewHost, ViewPage } from "./backend.ts";
import { parseChord } from "./keys.ts";
import { PartitionPool } from "./partition-pool.ts";
import { PlacementBook, toWindowBounds, type Rect } from "./placement.ts";
import { WebSocketGate } from "./socket-gate.ts";
import { throttleDecision } from "./throttle.ts";

/** The app window whose renderer asked to place a view, and that renderer's page zoom. */
export interface PlacementHost {
  /** The renderer's `webContents.id`. */
  id: number;
  window: BaseWindow;
  zoom: number;
}

export interface ViewHostOptions {
  window(): BaseWindow | undefined;
  platform: NodeJS.Platform;
  log(message: string): void;
}

/** Schemes a view may load. http(s) requests are approved by the daemon through CDP Fetch. */
const passive = new Set(["about:", "data:", "blob:", "devtools:"]);
const fetched = new Set(["http:", "https:"]);
const sockets = new Set(["ws:", "wss:"]);

/** A hidden view the agent has not driven for this long runs its timers at background rate. */
const throttleIdleMs = 30_000;

/** Removes `navigator.serviceWorker` before any page script runs (ADR 0055: no workers). */
const blockServiceWorkers = `Object.defineProperty(Navigator.prototype, "serviceWorker", { get() { return undefined; }, configurable: false });`;

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * The app's in-app browser: Electron's own Chromium in `WebContentsView`s drawn inside a
 * thread's Browser panel. Persistent profiles get one partition per workspace and ephemeral
 * ones an in-memory partition from a pool, cleared before it is lent again; never the app's
 * session or the person's Chrome profile. Popups, downloads, permission prompts, dialogs and
 * service workers are refused before a view is reported open, and each refusal is reported
 * as an audit event. A hidden view the agent is not driving is background-throttled.
 */
export class EmbeddedViews implements ViewHost {
  private pages = new Map<string, EmbeddedPage>();
  private byContents = new Map<number, EmbeddedPage>();
  /** Partitions already given their handlers: the pool's few, plus one per workspace. */
  private configured = new Set<string>();
  private ephemeralPartitions = new PartitionPool("ace-browser-ephemeral-");
  private placements = new PlacementBook();
  private hosts = new Map<number, BaseWindow>();
  private options: ViewHostOptions;

  constructor(options: ViewHostOptions) {
    this.options = options;
  }

  async open(request: {
    sessionId: string;
    options: BrowserOpen;
    viewport: { width: number; height: number };
  }): Promise<ViewPage> {
    const window = this.options.window();
    if (!window || window.isDestroyed()) throw new Error("No ace window is open");
    const { threadId, workspaceId, profile } = request.options;
    if (this.pages.has(threadId)) throw new Error("This thread already has an embedded view");
    const ephemeral = profile !== "persistent";
    const pool = this.ephemeralPartitions;
    const partition = ephemeral ? pool.acquire() : `persist:ace-browser-${digest(workspaceId)}`;
    let view: WebContentsView;
    let partitionSession: Session;
    try {
      partitionSession = this.configure(partition);
      view = new WebContentsView({
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          // Full speed while driven or shown; `EmbeddedPage` throttles it when neither.
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
    } catch (error) {
      // Nothing ran in the partition, so it is still clean.
      if (ephemeral) pool.release(partition, true);
      throw error;
    }
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, ...request.viewport });
    window.contentView.addChildView(view);
    const page = new EmbeddedPage({
      view,
      session: partitionSession,
      released: ephemeral ? (cleared) => pool.release(partition, cleared) : undefined,
      window,
      platform: this.options.platform,
      log: this.options.log,
      forget: () => {
        if (this.pages.get(threadId) === page) this.pages.delete(threadId);
        this.byContents.delete(view.webContents.id);
      },
    });
    this.pages.set(threadId, page);
    this.byContents.set(view.webContents.id, page);
    // The renderer may have placed the thread's view before this one opened (a reopen).
    this.apply(threadId);
    try {
      await page.prepare(request.viewport);
    } catch (error) {
      await page.close();
      throw error;
    }
    return page;
  }

  /** Draw (or hide) a thread's view where a renderer's Browser tab shows its page. */
  place(placement: BrowserPlacement, host: PlacementHost): void {
    this.hosts.set(host.id, host.window);
    const bounds = toWindowBounds(placement.bounds, host.zoom);
    this.placements.set(placement.threadId, host.id, {
      bounds,
      visible: placement.visible,
      input: placement.input,
    });
    this.apply(placement.threadId);
  }

  /** The renderer (`webContents.id`) showing a thread's view now, if any shows it. */
  shownIn(threadId: string): number | undefined {
    const placement = this.placements.resolve(threadId);
    return placement.visible ? placement.host : undefined;
  }

  /** A renderer reloaded or closed: the views it placed no longer belong where it put them. */
  forgetHost(id: number): void {
    this.hosts.delete(id);
    for (const threadId of this.placements.forgetHost(id)) this.apply(threadId);
  }

  private apply(threadId: string): void {
    const page = this.pages.get(threadId);
    if (!page) return;
    const placement = this.placements.resolve(threadId);
    const window = placement.host === undefined ? undefined : this.hosts.get(placement.host);
    page.place({
      window: window && !window.isDestroyed() ? window : undefined,
      bounds: placement.bounds,
      visible: placement.visible,
      input: placement.input,
    });
  }

  private configure(partition: string): Session {
    const partitionSession = sessions.fromPartition(partition);
    if (this.configured.has(partition)) return partitionSession;
    this.configured.add(partition);
    const page = (contents: WebContents | null | undefined) =>
      contents ? this.byContents.get(contents.id) : undefined;
    partitionSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(false);
      page(contents)?.emit("ace.permissionDenied", {
        origin: originOf(details.requestingUrl || contents.getURL()),
        permission,
      });
    });
    partitionSession.setPermissionCheckHandler(() => false);
    partitionSession.setDevicePermissionHandler(() => false);
    partitionSession.on("will-download", (event, item, contents) => {
      event.preventDefault();
      page(contents)?.emit("ace.downloadDenied", {
        url: item.getURL().slice(0, 8192),
        suggestedFilename: item.getFilename().slice(0, 256),
      });
    });
    // Belt and braces with the page script: drop any worker that still registers.
    void partitionSession.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {});
    partitionSession.serviceWorkers.on("registration-completed", () => {
      void partitionSession.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {});
    });
    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return callback({ cancel: true });
      }
      if (url.username || url.password) return callback({ cancel: true });
      if (passive.has(url.protocol) || fetched.has(url.protocol)) return callback({});
      if (sockets.has(url.protocol)) {
        const owner =
          details.webContentsId === undefined
            ? undefined
            : this.byContents.get(details.webContentsId);
        return callback({ cancel: !owner?.allowsSocket(details.url) });
      }
      callback({ cancel: true });
    });
    return partitionSession;
  }
}

interface PageOptions {
  view: WebContentsView;
  session: Session;
  /** Ephemeral sessions: the partition was cleared (or not) and may go back to its pool. */
  released: ((cleared: boolean) => void) | undefined;
  window: BaseWindow;
  platform: NodeJS.Platform;
  log(message: string): void;
  forget(): void;
}

class EmbeddedPage implements ViewPage {
  private options: PageOptions;
  private contents: WebContents;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private blocked = new Set<() => void>();
  private gate = new WebSocketGate();
  private nativeInput = false;
  /** The renderer showing the view holds control on the person's behalf. */
  private placedInput = false;
  /** Agent input in flight (CDP `Input.*` or a key press), which must not be blocked. */
  private agentInput = 0;
  private lastBlocked = 0;
  private placed = false;
  private closing: Promise<void> | undefined;
  private detachedSent = false;
  private lastDrivenAt = Date.now();
  private screencasting = false;
  private throttled = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PageOptions) {
    this.options = options;
    this.contents = options.view.webContents;
    const contents = this.contents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("before-input-event", (event, input) => {
      if (this.allowInput()) return;
      event.preventDefault();
      if (input.type === "keyDown") this.reportBlocked();
    });
    contents.on("before-mouse-event", (event, mouse) => {
      if (this.allowInput()) return;
      event.preventDefault();
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel") this.reportBlocked();
    });
    contents.debugger.on("message", (_event, method: string, params: unknown, sessionId) => {
      // Flattened child sessions are not part of the relay; the daemon uses
      // Target.sendMessageToTarget, whose replies arrive on the root session.
      if (sessionId) return;
      this.gate.event(method, params);
      if (method === "Page.javascriptDialogOpening")
        void this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
      this.emit(method, params);
    });
    contents.debugger.on("detach", (_event, reason) => this.detached(reason));
    contents.on("render-process-gone", (_event, details) => this.detached(details.reason));
    contents.on("destroyed", () => this.detached("Browser view destroyed"));
  }

  /** Attach CDP and install the refusals before the daemon sees the view. */
  async prepare(viewport: { width: number; height: number }): Promise<void> {
    // A view that never navigated has no renderer, and CDP domains wait for one forever.
    await this.contents.loadURL("about:blank");
    this.contents.debugger.attach("1.3");
    await this.send("Page.enable");
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: blockServiceWorkers,
      runImmediately: true,
    });
    await this.resize(viewport.width, viewport.height);
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.listeners) listener(method, params);
  }

  allowsSocket(url: string): boolean {
    return this.gate.allows(url);
  }

  /** Bounds are in the window's DIPs; a hidden view keeps its last box. */
  place(target: {
    window: BaseWindow | undefined;
    bounds: Rect | undefined;
    visible: boolean;
    input: boolean;
  }) {
    const view = this.options.view;
    const current = this.options.window;
    if (target.window && target.window !== current) {
      if (!current.isDestroyed()) current.contentView.removeChildView(view);
      target.window.contentView.addChildView(view);
      this.options.window = target.window;
    }
    if (target.bounds) view.setBounds(target.bounds);
    this.placed = target.visible && target.bounds !== undefined;
    this.placedInput = this.placed && target.input;
    // Hidden views stay alive (and attached) but stop painting, and send no frames.
    view.setVisible(this.placed);
    this.updateThrottle();
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "Page.startScreencast") this.screencasting = true;
    else if (method === "Page.stopScreencast") this.screencasting = false;
    this.driven();
    this.gate.command(method, params);
    if (!method.startsWith("Input.")) return this.send(method, params);
    this.agentInput++;
    try {
      return await this.send(method, params);
    } finally {
      this.agentInput--;
    }
  }

  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onBlockedInput(listener: () => void): () => void {
    this.blocked.add(listener);
    return () => this.blocked.delete(listener);
  }

  navigate(url: string, timeoutMs: number): Promise<string> {
    this.driven();
    const contents = this.contents;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.off("dom-ready", ready);
        contents.off("did-fail-load", failed);
        if (error) reject(error);
        else resolve(contents.getURL());
      };
      const ready = () => finish();
      const failed = (
        _event: unknown,
        code: number,
        description: string,
        _url: string,
        isMainFrame: boolean,
      ) => {
        // -3 is ERR_ABORTED: a newer navigation replaced this one.
        if (isMainFrame && code !== -3)
          finish(new Error(description || `Navigation failed (${code})`));
      };
      const timer = setTimeout(() => finish(new Error("Navigation timed out")), timeoutMs);
      contents.on("dom-ready", ready);
      contents.on("did-fail-load", failed);
      this.send("Page.navigate", { url })
        .then((result) => {
          if (typeof result !== "object" || result === null) return;
          if ("errorText" in result && typeof result.errorText === "string" && result.errorText)
            finish(new Error(result.errorText));
          // No loader: a same-document navigation, which fires no DOMContentLoaded.
          else if (!("loaderId" in result) || !result.loaderId) finish();
        })
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  async press(key: string): Promise<void> {
    this.driven();
    const press = parseChord(key, this.options.platform);
    this.agentInput++;
    try {
      const { keyCode, modifiers } = press;
      this.contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (press.text)
        this.contents.sendInputEvent({ type: "char", keyCode: press.text, modifiers });
      this.contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      // Let the page take the events before native input is gated again.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      this.agentInput--;
    }
  }

  async resize(width: number, height: number): Promise<void> {
    this.driven();
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    // A view the renderer is not showing takes the requested size itself.
    if (!this.placed) this.options.view.setBounds({ x: 0, y: 0, width, height });
  }

  setNativeInput(enabled: boolean): void {
    this.nativeInput = enabled;
    this.updateThrottle();
  }

  url(): string {
    return this.contents.isDestroyed() ? "about:blank" : this.contents.getURL() || "about:blank";
  }

  close(): Promise<void> {
    this.closing ??= this.destroy();
    return this.closing;
  }

  private async destroy(): Promise<void> {
    this.options.forget();
    this.listeners.clear();
    this.blocked.clear();
    clearTimeout(this.throttleTimer);
    const { view, window, session, released } = this.options;
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    const contents = this.contents;
    if (!contents.isDestroyed()) {
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.close();
    }
    if (released) released(await clearPartition(session));
  }

  /** The agent used the view: full speed now, and throttled again once it goes quiet. */
  private driven(): void {
    this.lastDrivenAt = Date.now();
    if (this.throttled) this.updateThrottle();
    // One pending check at a time, however many commands arrive (frame acks are commands).
    else this.throttleTimer ??= setTimeout(() => this.updateThrottle(), throttleIdleMs);
  }

  private updateThrottle(): void {
    clearTimeout(this.throttleTimer);
    this.throttleTimer = undefined;
    if (this.closing || this.contents.isDestroyed()) return;
    const decision = throttleDecision(
      {
        visible: this.placed,
        nativeInput: this.nativeInput || this.placedInput,
        screencasting: this.screencasting,
        lastDrivenAt: this.lastDrivenAt,
      },
      Date.now(),
      throttleIdleMs,
    );
    if (decision.throttle !== this.throttled) {
      this.throttled = decision.throttle;
      this.contents.setBackgroundThrottling(decision.throttle);
    }
    if (!decision.throttle && decision.recheckInMs !== undefined)
      this.throttleTimer = setTimeout(() => this.updateThrottle(), decision.recheckInMs);
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.contents.isDestroyed()) return Promise.reject(new Error("Browser view closed"));
    return this.contents.debugger.sendCommand(method, params ?? {});
  }

  private allowInput(): boolean {
    return this.nativeInput || this.placedInput || this.agentInput > 0;
  }

  /** At most one take-control request a second, however fast the person clicks. */
  private reportBlocked(): void {
    const now = Date.now();
    if (now - this.lastBlocked < 1_000) return;
    this.lastBlocked = now;
    for (const listener of this.blocked) listener();
  }

  /** The view went away without the daemon asking: tell it once, as CDP would. */
  private detached(reason: string): void {
    if (this.closing || this.detachedSent) return;
    this.detachedSent = true;
    this.emit("Inspector.detached", { reason });
  }
}

/**
 * Everything an ephemeral session left behind (storage, cookies, caches, auth, DNS, open
 * connections), so the partition can serve the next session. False if any of it failed.
 */
async function clearPartition(session: Session): Promise<boolean> {
  try {
    await session.closeAllConnections();
    await session.clearData();
    await session.clearStorageData();
    await session.clearCache();
    await session.clearAuthCache();
    await session.clearHostResolverCache();
    await session.clearCodeCaches({});
    return true;
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  try {
    return new URL(value).origin.slice(0, 8192);
  } catch {
    return "null";
  }
}
