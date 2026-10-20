import { quitNeedsConfirmation } from "./os/quit-guard.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { notificationOutbox } from "./link/notification-outbox.ts";
import { dirname, join } from "node:path";
import type { BaseWindow, BrowserWindow } from "electron";
import type { BrowserPlacement, DeepLink, DesktopSettings } from "../shared/contract.ts";
import type { BackendConnection } from "./browser/connection.ts";
import type { EmbeddedViews, PlacementHost } from "./browser/views.ts";
import type { VideoEncoderHost } from "./browser/video-encoder.ts";
import type { DaemonRuntime } from "./daemon/runtime.ts";
import type { DesktopLink } from "./link/desktop-link.ts";
import { LinkKeeper, runtimeLinkSource, type Endpoint } from "./link/link-keeper.ts";
import { NativeNotifier } from "./notifications/native.ts";
import { NotificationRouter, type Alert } from "./notifications/router.ts";
import { Attention } from "./os/attention.ts";
import { StatusTray } from "./os/tray.ts";
import { appLifetime } from "./os/lifetime.ts";

export interface BackgroundOptions {
  userData: string;
  /** The tray's template image (`appPaths().trayIcon`). */
  trayIcon: string;
  browserPreload?: string | undefined;
  /** The system's Downloads folder (`app.getPath("downloads")`): native pages' default. */
  downloads: string;
  runtime: DaemonRuntime;
  settings(): DesktopSettings;
  window(): BrowserWindow | undefined;
  open(link?: DeepLink): void;
  quitAll(): void;
  log(message: string): void;
}

/** How long Quit waits for the daemon link to close before it moves on. */
const stopGraceMs = 2_000;

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * The parts that keep working with every window closed: the daemon link (notifications,
 * badge, power save), the tray and the embedded browser backend, whose views wait in the
 * parking window while no app window shows them. It also decides when a windowless app quits
 * (`appLifetime`): never while an agent works or a thread has a native page.
 *
 * The link (`@ace/client` and most protocol schemas) and the browser backend are loaded on
 * first use, so neither delays the first window: the link when a daemon is first ready, the
 * browser once a local daemon is running.
 */
export class Background {
  readonly router: NotificationRouter;
  readonly attention: Attention;
  readonly tray: StatusTray;
  private links: LinkKeeper<DesktopLink> | undefined;
  private browser:
    | { connection: BackendConnection; views: EmbeddedViews; video: VideoEncoderHost | undefined }
    | undefined;
  private browserLoad: Promise<void> | undefined;
  private stopped = false;
  /** Agents working, as the daemon link last reported. */
  private working = 0;
  private hadWindow = false;
  private notifier: NativeNotifier;
  private options: BackgroundOptions;

  constructor(options: BackgroundOptions) {
    this.options = options;
    this.router = new NotificationRouter(options.settings().notifications, {
      now: Date.now,
      minuteOfDay: (at) => {
        const date = new Date(at);
        return date.getHours() * 60 + date.getMinutes();
      },
    });
    this.attention = new Attention(options.settings, options.window);
    this.tray = new StatusTray(
      {
        open: () => options.open(),
        pause: (paused) =>
          void options.runtime.pause(paused).catch((error: unknown) => options.log(String(error))),
        quitAll: options.quitAll,
      },
      options.trayIcon,
    );
    this.notifier = new NativeNotifier({
      open: (link) => options.open(link),
      send: (command) =>
        this.link?.enqueue(command.id, command.payload) ?? Promise.reject(new Error("offline")),
      log: options.log,
    });
    options.runtime.onStatus((status) => this.tray.update({ status }));
  }

  /**
   * Follow the daemon for the app's whole life: the link attaches whenever a daemon becomes
   * ready, however many failed starts came first. The fake target has no daemon to link to.
   */
  start(): void {
    const { runtime } = this.options;
    if (runtime.target.kind === "fake" || this.stopped) return;
    runtime.onStatus(() => this.loadBrowser());
    this.loadBrowser();
    this.links = new LinkKeeper(
      runtimeLinkSource(this.options.runtime),
      (endpoint) => this.createLink(endpoint),
      this.options.log,
    );
    this.links.start();
  }

  private get link(): DesktopLink | undefined {
    return this.links?.link();
  }

  private async createLink(endpoint: Endpoint): Promise<DesktopLink> {
    const { DesktopLink } = await import("./link/desktop-link.ts");
    const deviceId = this.deviceId();
    return new DesktopLink({
      url: endpoint.url,
      token: endpoint.token,
      deviceId,
      ...(endpoint.pairedDeviceId ? { pairedDeviceId: endpoint.pairedDeviceId } : {}),
      ...(endpoint.localHostId ? { localHostId: endpoint.localHostId } : {}),
      storage: notificationOutbox(this.options.userData, {
        url: endpoint.url,
        deviceId: endpoint.pairedDeviceId ?? deviceId,
        ...(endpoint.localHostId ? { localHostId: endpoint.localHostId } : {}),
      }),
      quietHours: () => {
        const hours = this.options.settings().notifications.quietHours;
        return hours
          ? {
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              startMinute: hours.start,
              endMinute: hours.end,
            }
          : null;
      },
      onAlert: (alert) => void this.alert(alert),
      onClose: (code, reason) =>
        this.options.log(`Daemon link closed: ${code}${reason ? ` ${reason}` : ""}`),
      onSummary: (summary) => {
        this.attention.update(summary);
        this.tray.update({ summary });
        if (summary.working === this.working) return;
        this.working = summary.working;
        this.reviewLifetime();
      },
    });
  }

  /**
   * The embedded browser backend, on its own socket (never the notification link). It is
   * local only: the credential lives in the daemon's ACE_HOME, so a remote daemon gets none.
   * Its code loads the first time a local daemon is running.
   */
  private loadBrowser(): void {
    const { runtime } = this.options;
    const target = runtime.target;
    if (this.browserLoad || this.stopped) return;
    if (target.kind !== "managed" && target.kind !== "attach") return;
    if (runtime.current().state !== "running") return;
    this.browserLoad = this.startBrowser(target.home).catch((error: unknown) =>
      this.options.log(`Embedded browser backend: ${String(error)}`),
    );
  }

  private async startBrowser(home: string): Promise<void> {
    const [
      { BrowserBackend },
      { BackendConnection },
      { readDesktopCredential },
      { EmbeddedViews },
      { VideoEncoderHost },
    ] = await Promise.all([
      import("./browser/backend.ts"),
      import("./browser/connection.ts"),
      import("./browser/credential.ts"),
      import("./browser/views.ts"),
      import("./browser/video-encoder.ts"),
    ]);
    if (this.stopped) return;
    const { runtime, log } = this.options;
    // Remote viewers watch the views as video from the app's own encoder (ADR 0088).
    const preload = this.options.browserPreload;
    const video = preload
      ? new VideoEncoderHost({ preload: join(dirname(preload), "video-encoder-preload.cjs"), log })
      : undefined;
    const views = new EmbeddedViews({
      preload: this.options.browserPreload,
      window: this.options.window,
      partitionsDir: join(this.options.userData, "Partitions"),
      platform: process.platform,
      log,
      video,
      onPages: () => this.reviewLifetime(),
      // The person's chosen folder, else the system's Downloads folder.
      downloadFolder: () => this.options.settings().browserDownloads ?? this.options.downloads,
    });
    const backend = new BrowserBackend(views, { log, ...(video ? { video } : {}) });
    const connection = new BackendConnection(
      backend,
      {
        daemon: async () => {
          const daemon = await runtime.local();
          return { url: daemon.url, token: daemon.token };
        },
        credential: () => readDesktopCredential(home),
        socket: (url) => new WebSocket(url),
        timers,
        id: randomUUID,
        log,
      },
      { video: video !== undefined },
    );
    this.browser = { connection, views, video };
    connection.onState((state) => log(`Embedded browser backend: ${state}`));
    runtime.onStatus((status) => {
      if (status.state === "running") connection.wake();
    });
    connection.setAvailable(true);
  }

  private hasWindow(): boolean {
    const window = this.options.window();
    return Boolean(window && !window.isDestroyed());
  }

  /** An app window opened or closed. */
  windowChanged(): void {
    if (this.hasWindow()) this.hadWindow = true;
    this.loadBrowser();
    this.reviewLifetime();
  }

  /** An app window is about to close: its browser views move to the parking window first. */
  windowClosing(window: BaseWindow): void {
    this.browser?.views.evacuate(window);
  }

  /** Show the tray, or quit, as `appLifetime` says for what runs now. */
  private reviewLifetime(): void {
    if (this.stopped) return;
    const lifetime = appLifetime({
      platform: process.platform,
      background: this.options.settings().background,
      window: this.hasWindow(),
      browserPages: this.browser?.views.count() ?? 0,
      working: this.working,
    });
    if (lifetime.tray) this.tray.show();
    else this.tray.hide();
    // An app started hidden (in the background) has never had a window to close.
    if (lifetime.quit && this.hadWindow) this.options.quitAll();
  }

  /** Draw (or hide) a thread's embedded view where a renderer's Browser tab is. */
  async placeBrowser(
    placement: BrowserPlacement,
    host: PlacementHost,
  ): Promise<import("../shared/contract.ts").BrowserPlacementReceipt> {
    return this.browser?.views.place(placement, host) ?? "unavailable";
  }

  /** A window's renderer reloaded or went away: its views stop showing where it put them. */
  forgetBrowserHost(id: number): void {
    this.browser?.views.forgetHost(id);
  }

  /** The renderer (`webContents.id`) focused its own field: take OS focus from native views. */
  focusApp(id: number): void {
    this.browser?.views.focusApp(id);
  }

  /**
   * A picture of a thread's shown view as it is now (a PNG `data:` URL), for the renderer to
   * hold in its place while a menu or popover covers it; undefined when nothing shows.
   */
  snapshotBrowser(threadId: string, tabId?: string): Promise<string | undefined> {
    return this.browser?.views.snapshot(threadId, tabId) ?? Promise.resolve(undefined);
  }

  /** Print or developer tools for a thread's shown native tab; false when it has none here. */
  browserPage(request: import("../shared/contract.ts").BrowserPageAction): Promise<boolean> {
    return this.browser?.views.pageAction(request) ?? Promise.resolve(false);
  }

  /** Route an alert and show it if the rules allow; true when shown. */
  alert(alert: Alert): boolean {
    const decision = this.router.route(alert);
    if (decision.kind === "show") this.notifier.show(decision.notification);
    return decision.kind === "show";
  }

  setFocus(windowFocused: boolean, threadId: string | undefined): void {
    this.router.setFocus({ windowFocused, threadId });
    this.link?.setPresence(windowFocused ? (threadId ?? null) : null);
  }

  settingsChanged(settings: DesktopSettings): void {
    this.router.configure(settings.notifications);
    this.attention.refresh();
    this.link?.updatePreferences();
    this.reviewLifetime();
  }

  /** Quitting now would close browser pages that working agents just used (#952). */
  agentsBrowsing(now: number, systemShutdown: boolean): boolean {
    return quitNeedsConfirmation({
      working: this.working,
      lastAgentBrowse: this.browser?.views.lastDriven() ?? -Infinity,
      now,
      systemShutdown,
    });
  }

  wake(): void {
    this.links?.wake();
    this.browser?.connection.wake();
  }

  /**
   * Quit: dropping the backend socket tells the daemon to pause or move its sessions, and the
   * views close (Electron would not finish quitting with one alive).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const views = this.browser?.connection.close() ?? Promise.resolve();
    this.browser?.video?.close();
    // A link stuck mid-handshake or a view slow to close never holds up Quit for long.
    await new Promise<void>((resolve) => {
      const cancel = timers.set(stopGraceMs, resolve);
      void Promise.all([views, this.links?.close()])
        .catch(() => {})
        .finally(() => {
          cancel();
          resolve();
        });
    });
    this.tray.hide();
  }

  /** A stable notification device id for this installation. */
  private deviceId(): string {
    const path = join(this.options.userData, "device-id");
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (/^desktop-[0-9a-f-]{36}$/.test(existing)) return existing;
    } catch {
      // First run.
    }
    const created = `desktop-${randomUUID()}`;
    writeFileSync(path, created, { mode: 0o600 });
    return created;
  }
}
