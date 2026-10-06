import { findNativeText } from "./find.ts";
import { NativeDialogs } from "./dialogs.ts";
import { NativeDownloads } from "./downloads.ts";
import type { DownloadItem } from "electron";
import { z } from "zod";
import type { BaseWindow, Session, WebContents, WebContentsView } from "electron";
import type { ViewPage } from "./backend.ts";
import { appChord, browserChord } from "../shortcuts.ts";
import { parseChord } from "./keys.ts";
import { WebSocketGate } from "./socket-gate.ts";
import { throttleDecision } from "./throttle.ts";
import type { NativeDevice, Rect } from "./placement.ts";
import { clearPartition } from "./partition-cleanup.ts";
const throttleIdleMs = 30_000;
const blockServiceWorkers = `Object.defineProperty(Navigator.prototype, "serviceWorker", { get() { return undefined; }, configurable: false });`;
export interface PageOptions {
  view: WebContentsView;
  downloadDir?: string | undefined;
  session: Session;
  /** Ephemeral sessions: the partition was cleared (or not) and may go back to its pool. */
  released: ((cleared: boolean) => void) | undefined;
  window: BaseWindow;
  platform: NodeJS.Platform;
  log(message: string): void;
  /** Replays an app shortcut the person pressed in the page into the app's own page. */
  forward(accelerator: string): void;
  forget(): void;
}

export class EmbeddedPage implements ViewPage {
  private options: PageOptions;
  private contents: WebContents;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private blocked = new Set<() => void>();
  private gate = new WebSocketGate();
  private nativeInput = false;
  /**
   * Set only while this page itself dispatches an input event (a relayed CDP `Input.*`
   * command or a key press). Chromium runs Electron's input hooks synchronously inside that
   * dispatch, so the events it sees then are exactly the injected ones; a person's own events
   * arrive as separate tasks and never see it set. See `inject`.
   */
  private injecting = 0;
  private lastBlocked = 0;
  private placed = false;
  private metrics = "";
  private target: { bounds: Rect; zoom: number; device?: NativeDevice | undefined } | undefined;
  private downloads: NativeDownloads;
  private dialogs: NativeDialogs;
  private closing: Promise<void> | undefined;
  private detachedSent = false;
  private lastDrivenAt = Date.now();
  private screencasting = false;
  private throttled = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PageOptions) {
    this.options = options;
    this.downloads = new NativeDownloads(options.downloadDir, (method, params) =>
      this.emit(method, params),
    );
    this.contents = options.view.webContents;
    const contents = this.contents;
    this.dialogs = new NativeDialogs(contents, (method, params) => this.emit(method, params));
    contents.setWindowOpenHandler(({ url }) => {
      this.emit("ace.popupRequested", { url: url.slice(0, 8192) });
      return { action: "deny" };
    });
    contents.on("page-title-updated", (_event, title) =>
      this.emit("ace.title", { title: title.slice(0, 1024) }),
    );
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("before-input-event", (event, input) => {
      // The app's shortcuts keep working while the page has focus, whoever controls it; keys
      // an agent sends are the page's.
      const chord =
        this.injecting > 0
          ? undefined
          : (browserChord(input, options.platform) ?? appChord(input, options.platform));
      if (chord) {
        event.preventDefault();
        if (input.type === "keyDown" && !input.isAutoRepeat) options.forward(chord);
        return;
      }
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

  download(item: DownloadItem) {
    return this.downloads.accept(item);
  }

  checkSocket(url: string, reply: (allowed: boolean) => void): void {
    this.gate.request(url, (method, params) => this.emit(method, params), reply);
  }

  /** Bounds are in the window's DIPs; a hidden view keeps its last box. */
  place(target: {
    window: BaseWindow | undefined;
    bounds: Rect | undefined;
    visible: boolean;
    zoom?: number;
    device?: NativeDevice | undefined;
  }) {
    const view = this.options.view;
    const current = this.options.window;
    if (target.window && target.window !== current) {
      if (!current.isDestroyed()) current.contentView.removeChildView(view);
      target.window.contentView.addChildView(view);
      this.options.window = target.window;
    }
    if (target.bounds) view.setBounds(target.bounds);
    if (target.visible && target.bounds) {
      const zoom = target.zoom ?? 1;
      if (this.contents.getZoomFactor() !== zoom) this.contents.setZoomFactor(zoom);
      this.target = { bounds: target.bounds, zoom, device: target.device };
      const params = target.device
        ? {
            width: target.device.width,
            height: target.device.height,
            deviceScaleFactor: target.device.deviceScaleFactor ?? 0,
            mobile: target.device.mobile ?? false,
            scale: target.bounds.width / (target.device.width * zoom),
          }
        : undefined;
      const key = JSON.stringify(params ?? { zoom, ...target.bounds });
      if (key !== this.metrics) {
        this.metrics = key;
        this.emit("ace.viewport", this.viewport());
        void this.send(
          params ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
          params,
        ).catch((error) => this.options.log(String(error)));
      }
    }
    this.placed = target.visible && target.bounds !== undefined;
    // Hidden views stay alive (and attached) but stop painting, and send no frames.
    view.setVisible(this.placed);
    this.updateThrottle();
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "Emulation.setDeviceMetricsOverride" && this.placed && this.target) {
      if (!this.target.device) return this.send("Emulation.clearDeviceMetricsOverride");
      return this.send(method, {
        ...params,
        scale: this.target.bounds.width / (this.target.device.width * this.target.zoom),
      });
    }
    if (this.dialogs.answer(method, params)) return {};
    if (this.downloads.command(method, params)) return {};
    if (method === "ace.findText") {
      const { text, forward } = z
        .object({ text: z.string().max(4096), forward: z.boolean().default(true) })
        .parse(params);
      return findNativeText(this.contents, text, forward);
    }
    if (method === "ace.webSocketDecision") {
      this.gate.command(method, params);
      return {};
    }
    if (method === "Page.startScreencast") this.screencasting = true;
    else if (method === "Page.stopScreencast") this.screencasting = false;
    this.driven();
    this.gate.command(method, params);
    if (!method.startsWith("Input.")) return this.send(method, params);
    return this.inject(() => this.send(method, params));
  }

  /**
   * Run a synchronous input dispatch whose events must pass the native gate: the daemon only
   * relays input that its sender may give (an agent, or the person who holds the lease
   * elsewhere). No time window is opened: an event the dispatch doesn't produce synchronously
   * is treated as the person's and gated, so a change in Chromium fails closed.
   */
  private inject<T>(dispatch: () => T): T {
    this.injecting++;
    try {
      return dispatch();
    } finally {
      this.injecting--;
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
    const { keyCode, modifiers } = press;
    this.inject(() => {
      this.contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (press.text)
        this.contents.sendInputEvent({ type: "char", keyCode: press.text, modifiers });
      this.contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    });
    // Let the page handle the keys before the daemon reports the press done.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async resize(width: number, height: number): Promise<void> {
    this.driven();
    if (this.placed) return;
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

  viewport() {
    return this.target
      ? (this.target.device ?? {
          width: Math.round(this.target.bounds.width / this.target.zoom),
          height: Math.round(this.target.bounds.height / this.target.zoom),
        })
      : {
          width: this.options.view.getBounds().width,
          height: this.options.view.getBounds().height,
        };
  }

  url(): string {
    return this.contents.isDestroyed() ? "about:blank" : this.contents.getURL() || "about:blank";
  }

  close(): Promise<void> {
    this.closing ??= this.destroy();
    return this.closing;
  }

  private async destroy(): Promise<void> {
    this.dialogs.close();
    this.options.forget();
    this.gate.close();
    this.downloads.close();
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
        nativeInput: this.nativeInput,
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
    return this.nativeInput || this.injecting > 0;
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
