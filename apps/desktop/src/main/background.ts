import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webContents, type BrowserWindow } from "electron";
import type { BrowserPlacement, DeepLink, DesktopSettings } from "../shared/contract.ts";
import type { ControllerState } from "./browser/backend.ts";
import type { BackendConnection } from "./browser/connection.ts";
import type { EmbeddedViews, PlacementHost } from "./browser/views.ts";
import type { DaemonRuntime } from "./daemon/runtime.ts";
import type { DesktopLink } from "./link/desktop-link.ts";
import { emit } from "./ipc.ts";
import { LinkKeeper, runtimeLinkSource, type Endpoint } from "./link/link-keeper.ts";
import { NativeNotifier } from "./notifications/native.ts";
import { NotificationRouter, type Alert } from "./notifications/router.ts";
import { Attention } from "./os/attention.ts";
import { StatusTray } from "./os/tray.ts";

export interface BackgroundOptions {
  userData: string;
  /** The tray's template image (`appPaths().trayIcon`). */
  trayIcon: string;
  browserPreload?: string | undefined;
  runtime: DaemonRuntime;
  settings(): DesktopSettings;
  window(): BrowserWindow | undefined;
  open(link?: DeepLink): void;
  quitAll(): void;
  log(message: string): void;
  onController(state: ControllerState): void;
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
 * badge, power save) and the tray. The embedded browser backend is here too, but it is only
 * offered while a window exists to draw its views in.
 *
 * The link (`@ace/client` and most protocol schemas) and the browser backend are loaded on
 * first use, so neither delays the first window: the link when a daemon is first ready, the
 * browser once a daemon is running and a window exists.
 */
export class Background {
  readonly router: NotificationRouter;
  readonly attention: Attention;
  readonly tray: StatusTray;
  private links: LinkKeeper<DesktopLink> | undefined;
  private browser: { connection: BackendConnection; views: EmbeddedViews } | undefined;
  private browserLoad: Promise<void> | undefined;
  private stopped = false;
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
    return new DesktopLink({
      url: endpoint.url,
      token: endpoint.token,
      deviceId: this.deviceId(),
      storage: this.outbox(),
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
      onSummary: (summary) => {
        this.attention.update(summary);
        this.tray.update({ summary });
      },
    });
  }

  /**
   * The embedded browser backend, on its own socket (never the notification link). It is
   * local only: the credential lives in the daemon's ACE_HOME, so a remote daemon gets none.
   * Its code loads the first time a local daemon is running while a window exists.
   */
  private loadBrowser(): void {
    const { runtime } = this.options;
    const target = runtime.target;
    if (this.browserLoad || this.stopped) return;
    if (target.kind !== "managed" && target.kind !== "attach") return;
    if (runtime.current().state !== "running" || !this.hasWindow()) return;
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
    ] = await Promise.all([
      import("./browser/backend.ts"),
      import("./browser/connection.ts"),
      import("./browser/credential.ts"),
      import("./browser/views.ts"),
    ]);
    if (this.stopped) return;
    const { runtime, log } = this.options;
    const views = new EmbeddedViews({
      preload: this.options.browserPreload,
      window: this.options.window,
      platform: process.platform,
      log,
      onClaim: (threadId, owner) => backend.claimControl(threadId, owner),
    });
    const backend = new BrowserBackend(views, {
      onController: this.options.onController,
      onTakeover: (threadId) => this.wantsControl(threadId),
      log,
    });
    const connection = new BackendConnection(backend, {
      daemon: async () => {
        const daemon = await runtime.local();
        return { url: daemon.url, token: daemon.token };
      },
      credential: () => readDesktopCredential(home),
      socket: (url) => new WebSocket(url),
      timers,
      id: randomUUID,
      log,
    });
    this.browser = { connection, views };
    connection.onState((state) => log(`Embedded browser backend: ${state}`));
    runtime.onStatus((status) => {
      if (status.state === "running") connection.wake();
    });
    this.windowChanged();
  }

  private hasWindow(): boolean {
    const window = this.options.window();
    return Boolean(window && !window.isDestroyed());
  }

  /** Views need a window to draw in: offer the backend only while one exists. */
  windowChanged(): void {
    this.loadBrowser();
    this.browser?.connection.setAvailable(this.hasWindow());
  }

  /** Draw (or hide) a thread's embedded view where a renderer's Browser tab is. */
  placeBrowser(placement: BrowserPlacement, host: PlacementHost): void {
    this.browser?.views.place(placement, host);
  }

  /** A window's renderer reloaded or went away: its views stop showing where it put them. */
  forgetBrowserHost(id: number): void {
    this.browser?.views.forgetHost(id);
  }

  /**
   * The person clicked or typed on a view they don't control. The renderer showing it takes
   * control through its own daemon connection, the one its address bar and buttons use; with
   * no renderer showing it, this app's backend connection asks.
   */
  private wantsControl(threadId: string): void {
    const host = this.browser?.views.shownIn(threadId);
    const renderer = host === undefined ? undefined : webContents.fromId(host);
    if (renderer) emit(renderer, "browser.wants-control", { threadId });
    else this.browser?.connection.takeover(threadId);
  }

  /** The person asked for control of a thread's view (`human`) or gave it back. */
  browserControl(threadId: string, controller: "agent" | "human"): void {
    if (controller === "human") this.browser?.connection.takeover(threadId);
    else this.browser?.connection.handback(threadId);
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
    if (settings.background) this.tray.show();
    else this.tray.hide();
  }

  wake(): void {
    this.links?.wake();
    this.browser?.connection.wake();
  }

  /** Quit: dropping the backend socket tells the daemon to pause or move its sessions. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.browser?.connection.close();
    // A link stuck mid-handshake never holds up Quit: the daemon still drops its socket.
    await new Promise<void>((resolve) => {
      const cancel = timers.set(stopGraceMs, resolve);
      void (this.links?.close() ?? Promise.resolve())
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

  private outbox() {
    const path = join(this.options.userData, "outbox.json");
    return {
      load: () => readFile(path, "utf8").catch(() => null),
      save: (value: string) => writeFile(path, value, { mode: 0o600 }),
    };
  }
}
