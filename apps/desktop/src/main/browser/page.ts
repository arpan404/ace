import { agentWork } from "../os/quit-guard.ts";
import { RendererRecovery } from "./renderer-recovery.ts";
import { NativeBasicAuth } from "./basic-auth.ts";
import { NativePopups } from "./popups.ts";
import { popupNavigation, UserActivation } from "./popup-navigation.ts";
import { PageMetrics } from "./page-metrics.ts";
import { findNativeText } from "./find.ts";
import { NativeDialogs } from "./dialogs.ts";
import { NativeDownloads } from "./downloads.ts";
import type { DownloadItem } from "electron";
import { z } from "zod";
import type { BaseWindow, Session, WebContents, WebContentsView } from "electron";
import type { ViewPage } from "./backend.ts";
import { appChord, browserChord, pageChord } from "../shortcuts.ts";
import { parseChord } from "./keys.ts";
import { WebSocketGate } from "./socket-gate.ts";
import { throttleDecision, type ViewPresence } from "./throttle.ts";
import { agentEmulation, deviceEmulation, type NativeDevice, type Rect } from "./placement.ts";
import { changesEmulationScale, emulationScale, scaledInput } from "./input-scale.ts";
import { clearPartition } from "./partition-cleanup.ts";
import { PausedRequests } from "./paused-requests.ts";
import { CrashBackoff } from "./crash-backoff.ts";
import { FocusHandoff, type ReplayedKey } from "./focus-handoff.ts";
import { popupContextMenu } from "./context-menu.ts";
import { openDevTools, printPage } from "./devtools.ts";
import type { BrowserContextAction } from "../../shared/contract.ts";
import { HumanInputReports } from "./human-input.ts";
import { UnloadGuard } from "./unload.ts";
import type { CertificateExceptions } from "./certificates.ts";
import { audioMuted } from "./audio.ts";
import { PageVideo, type PageVideoHost } from "./page-video.ts";
import { cookieExport } from "./cookie-export.ts";
const throttleIdleMs = 30_000;
/** The longest the view keeps keys for the app before giving them up. */
const handoffMs = 1_000;
const blockServiceWorkers = `Object.defineProperty(Navigator.prototype, "serviceWorker", { get() { return undefined; }, configurable: false });`;
export interface PageOptions {
  view: WebContentsView;
  downloadDir?: string | undefined;
  /** The folder the person chose for this app's browser downloads, read per download. */
  downloadFolder?(): string | undefined;
  session: Session;
  /** Ephemeral sessions: the partition was cleared (or not) and may go back to its pool. */
  released: ((cleared: boolean) => void) | undefined;
  window: BaseWindow;
  /** The app's hidden window where an unseen view renders while an agent drives it. */
  park(size: { width: number; height: number }): BaseWindow;
  platform: NodeJS.Platform;
  log(message: string): void;
  /** Replays an app shortcut the person pressed in the page into the app's own page. */
  forward(accelerator: string): void;
  /** A context menu pick the app carries out (history, a new tab, annotate, page source). */
  contextAction?(action: BrowserContextAction["action"], url?: string): void;
  forget(): void;
  authPreload?: string | undefined;
  rememberPopup?(contents: WebContents): () => void;
  /** Asks the person whether to leave a page that warns of unsaved changes; true: leave. */
  confirmLeave(window: BaseWindow): boolean;
  /** Certificates the person trusted in this thread's browser (shared by its tabs). */
  certificates?: CertificateExceptions | undefined;
  /** The app's video encoder, for `ace.video.*` (ADR 0088); absent: no video. */
  video?: PageVideoHost<WebContents> | undefined;
}

export class EmbeddedPage implements ViewPage {
  private options: PageOptions;
  private contents: WebContents;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private humanInput = new Set<() => void>();
  private gate = new WebSocketGate(new Set(["http:", "https:", "ws:", "wss:"]));
  private readonly recovery: RendererRecovery;
  private pageZoom = 1;
  private appliedZoom = 1;
  private appZoom = 1;
  private nativeInput = false;
  private agentControl = false;
  /** A page writes the clipboard only on the person's own recent click or key press. */
  allowsClipboard(): boolean {
    return this.nativeInput && this.activation.byPerson();
  }
  /**
   * Set only while this page itself dispatches an input event (a relayed CDP `Input.*`
   * command or a key press). Chromium runs Electron's input hooks synchronously inside that
   * dispatch, so the events it sees then are exactly the injected ones; a person's own events
   * arrive as separate tasks and never see it set. See `inject`.
   */
  private injecting = 0;
  /**
   * The daemon holds an agent's input in this tab while the person is busy here (ADR 0067,
   * collaboration).
   */
  private human = new HumanInputReports(
    {
      now: () => Date.now(),
      set: (delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
    },
    () => {
      for (const listener of this.humanInput) listener();
    },
  );
  private placed = false;
  /** Hidden only while the app's menu covers it: the person still watches it. */
  private covered = false;
  private placementPending = false;
  private placementGeneration = 0;
  /** The window a renderer last placed this view in; parking never changes it. */
  private home: BaseWindow;
  private presence: ViewPresence = "hidden";
  private metrics = new PageMetrics();
  /** The scale the page is drawn at under device emulation; CDP input is scaled to match. */
  private inputScale = 1;
  private target: { bounds: Rect; zoom: number; device?: NativeDevice | undefined } | undefined;
  private downloads: NativeDownloads;
  private popups: NativePopups;
  private activation = new UserActivation(() => Date.now());
  private auth: NativeBasicAuth;
  private dialogs: NativeDialogs;
  private closing: Promise<void> | undefined;
  private detachedSent = false;
  private lastDrivenAt = Date.now();
  /** When an agent last read or acted in this view (`agentWork`); never: -∞. */
  private drivenAt = -Infinity;
  private screencasting = false;
  /** Video captures of this view; they keep it rendering like a screencast. */
  private video: PageVideo<WebContents> | undefined;
  private throttled = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  private paused = new PausedRequests();
  /** The daemon link is down: nothing the daemon decides can be decided now. */
  private orphaned = false;
  private crashes = new CrashBackoff();
  /** Repeated crashes stopped the automatic reloads; a manual reload restarts the page. */
  private crashed = false;
  private crashReload: ReturnType<typeof setTimeout> | undefined;
  private handoff = new FocusHandoff();
  /** When the person last pressed the right button here: only their clicks open the menu. */
  private humanContextAt = -Infinity;
  private unload: UnloadGuard;
  /** The certificate the shown document last failed on, for the person to proceed past. */
  private certificateError: { url: string; fingerprint: string } | undefined;
  /** The person's own sound choice for this tab, once they made one. */
  private audioChoice: boolean | undefined;
  private audioReported = "";

  constructor(options: PageOptions) {
    this.options = options;
    this.recovery = new RendererRecovery(
      (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      () => this.detached("The browser page could not restart. Reopen it to continue."),
    );
    this.downloads = new NativeDownloads(
      options.downloadDir,
      (method, params) => this.emit(method, params),
      () => options.downloadFolder?.(),
    );
    this.contents = options.view.webContents;
    this.home = options.window;
    const contents = this.contents;
    if (options.video)
      this.video = new PageVideo(options.video, contents, () => this.updateThrottle());
    this.auth = new NativeBasicAuth(contents, () => this.nativeInput, options.authPreload);
    this.dialogs = new NativeDialogs(contents, (method, params) => this.emit(method, params));
    this.unload = new UnloadGuard(
      contents,
      () => ({ agentDriving: this.agentControl, personLeaving: this.activation.byPerson() }),
      () => options.confirmLeave(this.home),
      // The daemon's navigation fails at once instead of waiting for a load that never comes.
      () => this.emit("ace.unloadRefused", {}),
    );
    // A sign-in popup (window.opener, OAuth) opens for the person and for an agent's tab alike.
    this.popups = new NativePopups({
      contents,
      authPreload: options.authPreload,
      allowed: () => this.popupsAllowed(),
      emit: (method, params) => this.emit(method, params),
      remember: (popup) => options.rememberPopup?.(popup) ?? (() => {}),
      navigate: (url) => {
        const target = popupNavigation({
          url,
          current: contents.getURL(),
          activated: this.activation.active(),
        });
        if (target) this.emit("ace.popupRequested", { url: target.slice(0, 8192) });
      },
    });
    contents.on("page-title-updated", (_event, title) =>
      this.emit("ace.title", { title: title.slice(0, 1024) }),
    );
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("certificate-error", (event, url, _error, certificate, callback, isMainFrame) => {
      if (options.certificates?.allows(url, certificate.fingerprint)) {
        event.preventDefault();
        callback(true);
        return;
      }
      if (isMainFrame) this.certificateError = { url, fingerprint: certificate.fingerprint };
    });
    contents.on("before-input-event", (event, input) => {
      if (this.injecting === 0 && this.handoff.capture(Date.now(), input)) {
        event.preventDefault();
        return;
      }
      // Zoom and developer tools are the tab's, kept per tab by the daemon: the app's
      // toolbar (which shows the zoom) carries them out.
      const page = this.injecting === 0 ? pageChord(input, options.platform) : undefined;
      if (page) {
        event.preventDefault();
        if (input.type !== "keyDown" || input.isAutoRepeat) return;
        if (page === "CmdOrCtrl+P") void this.print();
        else if (page === "Alt+CmdOrCtrl+I") this.devtools();
        else options.forward(page);
        return;
      }
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
      if (this.allowInput()) {
        if (input.type === "keyDown")
          this.activation.note(this.injecting === 0 ? "person" : "agent");
        if (this.injecting === 0 && input.type === "keyDown") this.unload.personUsed();
        // Key up and IME composition count as much as key down.
        if (this.injecting === 0) this.human.key();
        return;
      }
      event.preventDefault();
    });
    contents.on("before-mouse-event", (event, mouse) => {
      if (this.injecting === 0 && mouse.type === "mouseDown" && mouse.button === "right")
        this.humanContextAt = Date.now();
      if (this.allowInput()) {
        if (mouse.type === "mouseDown")
          this.activation.note(this.injecting === 0 ? "person" : "agent");
        if (this.injecting === 0 && mouse.type === "mouseDown") this.unload.personUsed();
        if (this.injecting === 0) this.human.mouse(mouse.type, mouse.modifiers);
        return;
      }
      event.preventDefault();
    });
    contents.debugger.on("message", (_event, method: string, params: unknown, sessionId) => {
      // Flattened child sessions are not part of the relay; the daemon uses
      // Target.sendMessageToTarget, whose replies arrive on the root session.
      if (sessionId) return;
      if (method === "Inspector.detached") {
        setImmediate(() => {
          if (!this.ownsDetach()) this.detached("The browser page disconnected");
        });
        return;
      }
      const paused = this.paused.event(method, params);
      // Nobody can approve a load while the daemon link is down: refuse it (fail closed).
      if (this.orphaned)
        for (const request of paused) void this.paused.refuse((m, p) => this.send(m, p), request);
      this.emit(method, params);
    });
    contents.debugger.on("detach", (_event, reason) => {
      queueMicrotask(() => {
        if (!this.ownsDetach()) this.detached(reason);
      });
    });
    contents.on("render-process-gone", (_event, details) => this.rendererGone(details.reason));
    // An agent's right click (a CDP mouse event) opens nothing on the person's screen.
    contents.on("context-menu", (_event, params) => {
      const person =
        params.menuSourceType === "keyboard" || Date.now() - this.humanContextAt < 1_000;
      if (!person || !this.allowInput() || this.closing) return;
      popupContextMenu({
        window: this.options.window,
        contents,
        params,
        inspect: (at) => openDevTools(contents, at),
        app: (action, url) => options.contextAction?.(action, url),
      });
    });
    // Chromium keeps zoom per site: a new site would come up at its own level.
    contents.on("did-navigate", () => {
      if (!contents.isDestroyed() && contents.getZoomFactor() !== this.appliedZoom)
        contents.setZoomFactor(this.appliedZoom);
    });
    contents.on("audio-state-changed", () => this.reportAudio());
    // The person's own tab prints through the native dialog; an agent's or unseen tab, which no
    // dialog can show for, has ace save the page as a PDF instead.
    contents.ipc.on("ace:browser.print", () => {
      if (this.nativeInput && this.placed) contents.print({});
      else this.emit("ace.printRequested", {});
    });
    this.applyAudio();
    contents.on("destroyed", () => this.detached("Browser view destroyed"));
  }

  /**
   * The renderer died. It reloads (after a growing pause) and the daemon re-arms it through
   * `ace.rendererRestarted`; after repeated crashes it stays crashed and says so with
   * `ace.rendererCrashed`, until a reload asks for one more try (see `CrashBackoff`).
   */
  private rendererGone(reason: string): void {
    if (this.closing) return;
    this.paused.clear();
    clearTimeout(this.crashReload);
    // Drop stale Fetch interception before the replacement renderer loads. The session's
    // webRequest gate checks reload requests until CDP is guarded again.
    this.detachDebugger();
    const decision = this.crashes.crashed(Date.now());
    if (decision.kind === "give-up") {
      this.recovery.ready();
      this.crashed = true;
      this.emit("ace.rendererCrashed", { crashes: decision.crashes, reason });
      return;
    }
    this.restart(decision.delayMs);
  }

  /** Reload the dead renderer after `delayMs`, then attach CDP and tell the daemon. */
  private restart(delayMs: number): void {
    const contents = this.contents;
    this.crashed = false;
    this.recovery.start();
    this.crashReload = setTimeout(() => {
      if (this.closing || contents.isDestroyed()) return;
      contents.once("did-finish-load", () => {
        void (async () => {
          if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
          await this.send("Page.enable");
          await this.send("Runtime.enable");
          await this.send("Page.setInterceptFileChooserDialog", { enabled: this.agentControl });
          await this.send("Page.addScriptToEvaluateOnNewDocument", {
            source: blockServiceWorkers,
            runImmediately: true,
          });
          // Without a daemon to re-arm it, nothing will confirm the restart: it is done.
          if (this.orphaned) this.recovery.ready();
          this.emit("ace.rendererRestarted", {});
        })().catch(() => this.detached("The browser page could not restart"));
      });
      contents.reload();
    }, delayMs);
  }

  private detachDebugger(): void {
    // A new debugger session starts without the old one's emulation.
    this.inputScale = 1;
    const contents = this.contents;
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }

  /**
   * A detach this page caused: a crash restart, a crashed page, or a debugger swapped for a
   * fresh one (already attached again by the time Electron reports the old one's detach).
   */
  private ownsDetach(): boolean {
    return (
      this.recovery.active ||
      this.crashed ||
      (!this.contents.isDestroyed() && this.contents.debugger.isAttached())
    );
  }

  /** The daemon link dropped: the page lives on, refusing loads only the daemon may approve. */
  orphan(): void {
    this.orphaned = true;
    void this.paused.refuseAll((method, params) => this.send(method, params));
  }

  /**
   * A daemon adopts this page again, as if it had just opened it: a fresh CDP session with
   * only ace's own refusals, nothing paused and no screencast or emulation left from before.
   * The page itself (document, scroll, form state, history) is untouched.
   */
  async readopt(): Promise<void> {
    if (this.contents.isDestroyed()) throw new Error("Browser view closed");
    // A crashed page has nothing worth keeping: the daemon opens a fresh one instead.
    if (this.crashed || this.recovery.active) throw new Error("The browser page crashed");
    this.orphaned = false;
    this.paused.clear();
    this.screencasting = false;
    this.detachDebugger();
    this.contents.debugger.attach("1.3");
    await this.send("Page.enable");
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: blockServiceWorkers,
      runImmediately: true,
    });
    await this.send("Page.setInterceptFileChooserDialog", { enabled: this.agentControl });
    this.metrics = new PageMetrics();
    if (this.target && this.placed)
      this.place({
        window: this.home,
        bounds: this.target.bounds,
        visible: true,
        zoom: this.appZoom,
        device: this.target.device,
      });
    this.updateThrottle();
  }

  /** A shortcut sent typing to the app's own field: keep the keys typed here until it has it. */
  beginHandoff(): void {
    this.handoff.start(Date.now(), handoffMs);
  }

  /** Keys typed into the view since `beginHandoff`; the handoff ends. */
  takeHandoff(): ReplayedKey[] {
    return this.handoff.take();
  }

  /** The window holding the view is closing: the view moves, unseen, to the parking window. */
  evacuate(closing: BaseWindow, park: (size: { width: number; height: number }) => BaseWindow) {
    if (this.options.window !== closing) return;
    const view = this.options.view;
    const { width, height } = view.getBounds();
    view.setVisible(false);
    this.attach(park({ width, height }));
    view.setBounds({ x: 0, y: 0, width, height });
    this.placed = false;
    this.covered = false;
    this.updateThrottle();
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

  isRestarting(): boolean {
    return this.recovery.active;
  }

  checkPopupRequest(url: string, reply: (allowed: boolean) => void): void {
    this.popups.request(url, reply);
  }

  checkSocket(url: string, reply: (allowed: boolean) => void): void {
    this.gate.request(url, (method, params) => this.emit(method, params), reply);
  }

  /** Bounds are in the window's DIPs; a hidden view keeps its last box. */
  place(target: {
    window: BaseWindow | undefined;
    bounds: Rect | undefined;
    visible: boolean;
    covered?: boolean;
    zoom?: number;
    device?: NativeDevice | undefined;
  }) {
    const view = this.options.view;
    const generation = ++this.placementGeneration;

    if (target.window) this.home = target.window;
    this.placed = target.visible && target.bounds !== undefined && !this.home.isDestroyed();
    this.covered = !this.placed && target.covered === true && target.bounds !== undefined;
    if (this.placed) this.attach(this.home);
    if (target.bounds && (this.placed || this.presence !== "parked")) view.setBounds(target.bounds);
    if (target.visible && target.bounds) {
      this.appZoom = target.zoom ?? 1;
      const zoom = this.appZoom * this.pageZoom;
      this.appliedZoom = zoom;
      if (this.contents.getZoomFactor() !== zoom) this.contents.setZoomFactor(zoom);
      this.target = { bounds: target.bounds, zoom, device: target.device };
      const params = target.device
        ? deviceEmulation(target.device, target.bounds, this.appZoom)
        : undefined;
      const key = JSON.stringify(
        params ?? { zoom, width: target.bounds.width, height: target.bounds.height },
      );
      this.placementPending = !this.metrics.matches(key);
      this.emit("ace.viewport", this.viewport());
      void this.metrics
        .place(key, () =>
          this.emulate(
            params ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
            params,
          ),
        )
        .then(
          () => {
            if (generation !== this.placementGeneration) return;
            this.placementPending = false;
            this.updateThrottle();
          },
          (error) => {
            if (generation === this.placementGeneration) this.show("hidden");
            this.options.log(String(error));
          },
        );
    }
    // Hidden views stay alive (and attached) but stop painting, and send no frames, unless an
    // agent drives them: then they render in the parking window (see `ViewPresence`).
    this.updateThrottle();
    this.applyAudio();
  }

  async placementReady(): Promise<void> {
    await this.metrics.settled();
  }

  isShown(): boolean {
    return (
      !this.placementPending &&
      this.placed &&
      this.presence === "placed" &&
      !this.contents.isDestroyed()
    );
  }

  private attach(window: BaseWindow): void {
    const current = this.options.window;
    if (window === current) return;
    const view = this.options.view;
    if (!current.isDestroyed()) current.contentView.removeChildView(view);
    window.contentView.addChildView(view);
    this.options.window = window;
  }

  private show(presence: ViewPresence): void {
    this.presence = presence;
    const view = this.options.view;
    if (presence === "parked") {
      const { width, height } = view.getBounds();
      this.attach(this.options.park({ width, height }));
      view.setBounds({ x: 0, y: 0, width, height });
    }
    view.setVisible(presence !== "hidden");
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // Liveness for the daemon: answered here, without waiting on the page's renderer.
    if (method === "ace.ping")
      return { alive: !this.contents.isDestroyed(), crashed: this.crashed };
    // Watching is no driving: a captured view renders unthrottled for as long as it is captured.
    const video = this.video?.command(method, params);
    if (video) return video;
    if (this.crashed) {
      if (method !== "Page.reload") throw new Error("The page crashed. Reload it to try again.");
      this.restart(0);
      return {};
    }
    if (changesEmulationScale(method)) {
      return this.metrics.override(() => {
        // An agent's device on a shown page is drawn fitted into the panel; the person's
        // device toolbar takes it up and places the page at that size (`ace.tabs` lists it).
        if (this.placed && this.agentControl && this.target)
          return method === "Emulation.setDeviceMetricsOverride"
            ? this.emulate(method, this.fitted(params))
            : this.emulate(method);
        if (this.placed && this.target) {
          const { device, bounds } = this.target;
          return device
            ? this.emulate(
                "Emulation.setDeviceMetricsOverride",
                deviceEmulation(device, bounds, this.appZoom),
              )
            : this.emulate("Emulation.clearDeviceMetricsOverride");
        }
        return method === "Emulation.setDeviceMetricsOverride"
          ? this.emulate(method, this.fitted(params))
          : this.emulate(method);
      });
    }
    if (method === "ace.zoom") {
      this.pageZoom = z.object({ factor: z.number().min(0.25).max(5) }).parse(params).factor;
      this.applyZoom();
      return {};
    }
    if (method === "ace.clearData") {
      if (!(await clearPartition(this.options.session)))
        throw new Error("Browsing data could not be cleared");
      return {};
    }
    if (method === "ace.rendererReady") {
      this.recovery.ready();
      return {};
    }
    if (method === "ace.certificate.proceed") return this.proceedCertificate(params);
    if (method === "ace.audio.mute") {
      this.audioChoice = z.object({ muted: z.boolean() }).parse(params).muted;
      this.applyAudio();
      return {};
    }
    if (this.popups.command(method, params) || this.dialogs.answer(method, params)) return {};
    if (this.downloads.command(method, params)) return {};
    // The partition's sign-ins, for the daemon to carry to ace's Chromium (a locked screen).
    if (method === "ace.cookies") return cookieExport(await this.contents.session.cookies.get({}));
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
    // The daemon reads the history after every navigation (for Back and Forward). That is no
    // driving: an unseen tab whose page navigates by itself stays unrendered.
    if (method === "Page.getNavigationHistory") return this.send(method);
    // The daemon freezing an idle tab, or waking it before its next command, is no driving
    // either: a frozen view stays hidden and throttled (ADR 0083 lifecycle).
    if (method === "Page.setWebLifecycleState") return this.send(method, params);
    if (method === "Page.startScreencast") this.screencasting = true;
    else if (method === "Page.stopScreencast") this.screencasting = false;
    if (agentWork(method)) this.drivenAt = Date.now();
    this.driven();
    this.gate.command(method, params);
    this.paused.command(method, params);
    if (!method.startsWith("Input.")) return this.send(method, params);
    // Input comes in the page's CSS pixels; a device drawn scaled takes it scaled the same.
    return this.inject(() => this.send(method, scaledInput(method, params, this.inputScale)));
  }

  /**
   * Run a synchronous input dispatch whose events must pass the native gate: the daemon only
   * relays input from agents and from the person's other devices. No time window is opened: an event the dispatch doesn't produce synchronously
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

  /**
   * The page as it is drawn now, as a PNG `data:` URL; undefined while it is not on screen.
   * The renderer holds this picture exactly where the view is while one of its menus covers
   * the view, so the page never moves or resizes to make room (ADR 0085).
   */
  async picture(): Promise<string | undefined> {
    if (!this.placed || this.contents.isDestroyed()) return undefined;
    const image = await this.contents.capturePage();
    return image.isEmpty() ? undefined : image.toDataURL();
  }

  /** The person used the view: keys, IME, pointer moves, clicks, scrolls, drags (`HumanInputReports`). */
  onHumanInput(listener: () => void): () => void {
    this.humanInput.add(listener);
    return () => this.humanInput.delete(listener);
  }

  navigate(url: string, timeoutMs: number): Promise<string> {
    this.drivenAt = Date.now();
    if (this.crashed) return Promise.reject(new Error("The page crashed. Reload it to try again."));
    this.driven();
    const contents = this.contents;
    return new Promise((resolve, reject) => {
      let settled = false;
      /** The reply's ERR_ABORTED: another navigation took over, or loading was stopped. */
      let superseded: string | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.off("dom-ready", ready);
        contents.off("did-fail-load", failed);
        contents.off("did-stop-loading", stopped);
        if (error) reject(error);
        else resolve(contents.getURL());
      };
      // Any main-frame document counts: the one asked for, or one that replaced it.
      const ready = () => finish();
      // Nothing took over and nothing committed (Stop, a 204, a download).
      const stopped = () => {
        if (superseded) finish(new Error(superseded));
      };
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
      contents.on("did-stop-loading", stopped);
      this.send("Page.navigate", { url })
        .then((result) => {
          if (typeof result !== "object" || result === null) return;
          const errorText =
            "errorText" in result && typeof result.errorText === "string" ? result.errorText : "";
          if (errorText === "net::ERR_ABORTED") {
            superseded = errorText;
            if (!contents.isLoading()) stopped();
          } else if (errorText) finish(new Error(errorText));
          // No loader: a same-document navigation, which fires no DOMContentLoaded.
          else if (!("loaderId" in result) || !result.loaderId) finish();
        })
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }

  async press(key: string): Promise<void> {
    this.drivenAt = Date.now();
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
    const size = { width, height, deviceScaleFactor: 0, mobile: false };
    if (this.placed) {
      // The panel sizes a shown page; an agent's size is drawn fitted into it until the
      // person's device toolbar takes it up.
      if (this.agentControl)
        await this.metrics.override(() =>
          this.emulate("Emulation.setDeviceMetricsOverride", this.fitted(size)),
        );
      return;
    }
    // In DIPs: the size that lays the page out at `width` × `height` CSS pixels at its zoom.
    const emulated = this.fitted(size);
    await this.metrics.override(() =>
      this.placed
        ? Promise.resolve()
        : this.emulate("Emulation.setDeviceMetricsOverride", emulated),
    );
    // A view the renderer is not showing takes the requested size itself.
    if (this.placed) return;
    const bounds = {
      width: typeof emulated["width"] === "number" ? emulated["width"] : width,
      height: typeof emulated["height"] === "number" ? emulated["height"] : height,
    };
    if (this.presence === "parked") this.options.park(bounds);
    this.options.view.setBounds({ x: 0, y: 0, ...bounds });
  }

  /** The page zoom the daemon keeps for this tab, on top of the app window's own zoom. */
  private applyZoom(): void {
    const zoom = this.appZoom * this.pageZoom;
    this.appliedZoom = zoom;
    if (!this.contents.isDestroyed() && this.contents.getZoomFactor() !== zoom)
      this.contents.setZoomFactor(zoom);
    if (this.target && this.placed)
      this.place({
        window: this.home,
        bounds: this.target.bounds,
        visible: true,
        zoom: this.appZoom,
        device: this.target.device,
      });
  }

  /**
   * Device metrics in CSS pixels as Chromium takes them in the app's zoom (`agentEmulation`),
   * scaled so the whole device fits the box the panel gives a shown page. The tab's own zoom
   * still shrinks its CSS viewport, as zoom does in ace's Chrome.
   */
  private fitted(params: Record<string, unknown> | undefined): Record<string, unknown> {
    const size = z
      .object({ width: z.number().positive(), height: z.number().positive() })
      .safeParse(params);
    if (!size.success) return params ?? {};
    const bounds =
      this.placed && this.target
        ? this.target.bounds
        : { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
    return agentEmulation({ ...params, ...size.data }, bounds, this.appZoom);
  }

  /** An emulation change; input follows the drawing scale it leaves once it applied. */
  private async emulate(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const result = await this.send(method, params);
    this.inputScale = emulationScale(method, params);
    return result;
  }

  /** The tab's developer tools in their own window, at an element when `at` is given. */
  devtools(at?: { x: number; y: number }): void {
    openDevTools(this.contents, at);
  }

  print(): Promise<boolean> {
    return printPage(this.contents);
  }

  setNativeInput(enabled: boolean): void {
    this.nativeInput = enabled;
    if (!enabled) this.auth.close();
    if (!this.popupsAllowed()) this.popups.close();
    this.updateThrottle();
  }

  /** Sound follows the person's view (see `audioMuted`); the daemon hears of every change. */
  private applyAudio(): void {
    if (this.contents.isDestroyed()) return;
    const muted = audioMuted({
      shown: this.placed || this.covered,
      agentControl: this.agentControl,
      chosen: this.audioChoice,
    });
    if (this.contents.isAudioMuted() !== muted) this.contents.setAudioMuted(muted);
    this.reportAudio();
  }

  private reportAudio(): void {
    if (this.contents.isDestroyed()) return;
    const audio = {
      audible: this.contents.isCurrentlyAudible(),
      muted: this.contents.isAudioMuted(),
    };
    const key = JSON.stringify(audio);
    if (key === this.audioReported) return;
    this.audioReported = key;
    this.emit("ace.audio", audio);
  }

  /** Popups exist while the person or an agent uses the page, never for an idle unseen one. */
  private popupsAllowed(): boolean {
    return this.nativeInput || this.agentControl;
  }

  /**
   * The person proceeds past the certificate error they were shown for `url`: this thread's
   * browser trusts that origin's certificate (the one that failed) and loads the page again.
   * Only the daemon's person-only request sends this; agents have no path to it.
   */
  private async proceedCertificate(params: unknown): Promise<unknown> {
    const { url } = z.object({ url: z.string().max(8192) }).parse(params);
    const failed = this.certificateError;
    if (!failed || failed.url !== url || !this.options.certificates)
      throw new Error("Certificate error no longer shown");
    this.options.certificates.allow(failed.url, failed.fingerprint);
    this.certificateError = undefined;
    return this.send("Page.navigate", { url });
  }

  setAgentControl(agent: boolean): void {
    this.agentControl = agent;
    if (!this.popupsAllowed()) this.popups.close();
    this.applyAudio();
    void this.send("Page.setInterceptFileChooserDialog", { enabled: agent }).catch((error) =>
      this.options.log(String(error)),
    );
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
    this.video?.close();
    this.popups.close();
    this.auth.close();
    this.dialogs.close();
    this.options.forget();
    this.gate.close();
    this.downloads.close();
    this.listeners.clear();
    this.humanInput.clear();
    this.human.close();
    clearTimeout(this.throttleTimer);
    clearTimeout(this.crashReload);
    this.recovery.ready();
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
  /** When an agent last worked in this view: agents mid-browse make Quit ask first. */
  lastDriven(): number {
    return this.drivenAt;
  }

  private driven(): void {
    this.lastDrivenAt = Date.now();
    // An unseen, unrendered view starts rendering before the command reaches it.
    if (this.throttled || this.presence === "hidden") this.updateThrottle();
    // One pending check at a time, however many commands arrive (frame acks are commands).
    else this.throttleTimer ??= setTimeout(() => this.updateThrottle(), throttleIdleMs);
  }

  private updateThrottle(): void {
    clearTimeout(this.throttleTimer);
    this.throttleTimer = undefined;
    if (this.closing || this.contents.isDestroyed()) return;
    if (this.placementPending) {
      // A view already on screen stays there while its new box's metrics apply (a panel
      // resizing): hiding it meanwhile would flash.
      if (!(this.placed && this.presence === "placed")) this.show("hidden");
      return;
    }
    const decision = throttleDecision(
      {
        visible: this.placed,
        covered: this.covered,
        nativeInput: this.nativeInput,
        agentControl: this.agentControl,
        screencasting: this.screencasting,
        videoCapture: this.video?.capturing() ?? false,
        lastDrivenAt: this.lastDrivenAt,
      },
      Date.now(),
      throttleIdleMs,
    );
    this.show(decision.presence);
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

  /** The view went away without the daemon asking: tell it once, as CDP would. */
  private detached(reason: string): void {
    if (this.closing || this.detachedSent) return;
    this.detachedSent = true;
    this.emit("Inspector.detached", { reason });
  }
}
