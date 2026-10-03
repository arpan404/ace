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
import { WebSocketGate } from "./socket-gate.ts";

export interface ViewHostOptions {
  window(): BaseWindow | undefined;
  platform: NodeJS.Platform;
  log(message: string): void;
}

/** Schemes a view may load. http(s) requests are approved by the daemon through CDP Fetch. */
const passive = new Set(["about:", "data:", "blob:", "devtools:"]);
const fetched = new Set(["http:", "https:"]);
const sockets = new Set(["ws:", "wss:"]);

/** Removes `navigator.serviceWorker` before any page script runs (ADR 0055: no workers). */
const blockServiceWorkers = `Object.defineProperty(Navigator.prototype, "serviceWorker", { get() { return undefined; }, configurable: false });`;

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * The app's in-app browser: Electron's own Chromium in `WebContentsView`s drawn inside a
 * thread's Browser panel. Persistent profiles get one partition per workspace and ephemeral
 * ones a throwaway in-memory partition; never the app's session or the person's Chrome
 * profile. Popups, downloads, permission prompts, dialogs and service workers are refused
 * before a view is reported open, and each refusal is reported as an audit event.
 */
export class EmbeddedViews implements ViewHost {
  private pages = new Map<string, EmbeddedPage>();
  private byContents = new Map<number, EmbeddedPage>();
  private configured = new Set<string>();
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
    const partition = ephemeral
      ? `ace-browser-ephemeral-${digest(request.sessionId)}`
      : `persist:ace-browser-${digest(workspaceId)}`;
    const partitionSession = this.configure(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, ...request.viewport });
    window.contentView.addChildView(view);
    const page = new EmbeddedPage({
      view,
      session: partitionSession,
      ephemeral,
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
    try {
      await page.prepare(request.viewport);
    } catch (error) {
      await page.close();
      throw error;
    }
    return page;
  }

  /** Draw (or hide) a thread's view where the renderer's Browser panel is. */
  place(placement: BrowserPlacement): void {
    this.pages.get(placement.threadId)?.place(placement);
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
  ephemeral: boolean;
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
  /** Agent input in flight (CDP `Input.*` or a key press), which must not be blocked. */
  private agentInput = 0;
  private lastBlocked = 0;
  private placed = false;
  private closing: Promise<void> | undefined;
  private detachedSent = false;

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

  place(placement: BrowserPlacement): void {
    const { x, y, width, height } = placement.bounds;
    const view = this.options.view;
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    this.placed = placement.visible && width > 0 && height > 0;
    // Hidden views stay alive (and attached) but stop painting.
    view.setVisible(this.placed);
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
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
    const { view, window, session, ephemeral } = this.options;
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    const contents = this.contents;
    if (!contents.isDestroyed()) {
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.close();
    }
    if (ephemeral) {
      await session.clearStorageData().catch(() => {});
      await session.clearCache().catch(() => {});
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.contents.isDestroyed()) return Promise.reject(new Error("Browser view closed"));
    return this.contents.debugger.sendCommand(method, params ?? {});
  }

  private allowInput(): boolean {
    return this.nativeInput || this.agentInput > 0;
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

function originOf(value: string): string {
  try {
    return new URL(value).origin.slice(0, 8192);
  } catch {
    return "null";
  }
}
