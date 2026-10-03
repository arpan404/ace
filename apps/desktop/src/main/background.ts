import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { DeepLink, DesktopSettings } from "../shared/contract.ts";
import { BrowserBackend, type ControllerState } from "./browser/backend.ts";
import { BackendConnection } from "./browser/connection.ts";
import { readDesktopCredential } from "./browser/credential.ts";
import { EmbeddedViews } from "./browser/views.ts";
import type { DaemonRuntime } from "./daemon/runtime.ts";
import { DesktopLink } from "./link/desktop-link.ts";
import { NativeNotifier } from "./notifications/native.ts";
import { NotificationRouter, type Alert } from "./notifications/router.ts";
import { Attention } from "./os/attention.ts";
import { StatusTray } from "./os/tray.ts";

export interface BackgroundOptions {
  userData: string;
  runtime: DaemonRuntime;
  settings(): DesktopSettings;
  window(): BrowserWindow | undefined;
  open(link?: DeepLink): void;
  quitAll(): void;
  log(message: string): void;
  onController(state: ControllerState): void;
}

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
 */
export class Background {
  readonly router: NotificationRouter;
  readonly attention: Attention;
  readonly tray: StatusTray;
  readonly views: EmbeddedViews;
  private link: DesktopLink | undefined;
  private backend: BrowserBackend;
  private browser: BackendConnection | undefined;
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
    this.tray = new StatusTray({
      open: () => options.open(),
      pause: (paused) =>
        void options.runtime.pause(paused).catch((error: unknown) => options.log(String(error))),
      quitAll: options.quitAll,
    });
    this.views = new EmbeddedViews({
      window: options.window,
      platform: process.platform,
      log: options.log,
    });
    this.backend = new BrowserBackend(this.views, {
      onController: options.onController,
      onTakeover: (threadId) => this.browser?.takeover(threadId),
      log: options.log,
    });
    this.notifier = new NativeNotifier({
      open: (link) => options.open(link),
      send: (command) =>
        this.link?.enqueue(command.id, command.payload) ?? Promise.reject(new Error("offline")),
      log: options.log,
    });
    options.runtime.onStatus((status) => this.tray.update({ status }));
  }

  /** Connect once the daemon is reachable; the fake target has no daemon to link to. */
  async start(): Promise<void> {
    if (this.options.runtime.target.kind === "fake") return;
    this.startBrowser();
    const connection = await this.options.runtime.connection();
    if (connection.mode !== "daemon") return;
    const link = new DesktopLink({
      url: connection.url,
      token: connection.token,
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
    this.link = link;
    await link.start();
  }

  /**
   * The embedded browser backend, on its own socket (never the notification link). It is
   * local only: the credential lives in the daemon's ACE_HOME, so a remote daemon gets none.
   */
  private startBrowser(): void {
    const { runtime } = this.options;
    const target = runtime.target;
    if (target.kind !== "managed" && target.kind !== "attach") return;
    const home = target.home;
    const browser = new BackendConnection(this.backend, {
      daemon: async () => {
        const daemon = await runtime.local();
        return { url: daemon.url, token: daemon.token };
      },
      credential: () => readDesktopCredential(home),
      socket: (url) => new WebSocket(url),
      timers,
      id: randomUUID,
      log: this.options.log,
    });
    this.browser = browser;
    browser.onState((state) => this.options.log(`Embedded browser backend: ${state}`));
    runtime.onStatus((status) => {
      if (status.state === "running") browser.wake();
    });
    this.windowChanged();
  }

  /** Views need a window to draw in: offer the backend only while one exists. */
  windowChanged(): void {
    const window = this.options.window();
    this.browser?.setAvailable(Boolean(window && !window.isDestroyed()));
  }

  /** The person asked for control of a thread's view (`human`) or gave it back. */
  browserControl(threadId: string, controller: "agent" | "human"): void {
    if (controller === "human") this.browser?.takeover(threadId);
    else this.browser?.handback(threadId);
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
    this.link?.wake();
    this.browser?.wake();
  }

  /** Quit: dropping the backend socket tells the daemon to pause or move its sessions. */
  async stop(): Promise<void> {
    this.browser?.close();
    await this.link?.close().catch(() => {});
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
