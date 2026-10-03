import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { DeepLink, DesktopSettings } from "../shared/contract.ts";
import { BrowserBackend } from "./browser/backend.ts";
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
  onController(sessionId: string, controller: "agent" | "human"): void;
}

/**
 * The parts that keep working with every window closed: the daemon link (notifications,
 * badge, power save), the tray, and the embedded browser backend.
 */
export class Background {
  readonly router: NotificationRouter;
  readonly attention: Attention;
  readonly tray: StatusTray;
  readonly views: EmbeddedViews;
  private link: DesktopLink | undefined;
  private backend: BrowserBackend | undefined;
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
      pause: (paused) => void options.runtime.pause(paused).catch((error: unknown) => options.log(String(error))),
      quitAll: options.quitAll,
    });
    this.views = new EmbeddedViews({
      window: options.window,
      allowOrigin: (sessionId, origin) =>
        this.backend?.requestOrigin(sessionId, origin) ?? Promise.resolve(false),
      log: options.log,
    });
    this.notifier = new NativeNotifier({
      open: (link) => options.open(link),
      send: (command) => this.link?.enqueue(command.id, command.payload) ?? Promise.reject(new Error("offline")),
      log: options.log,
    });
    options.runtime.onStatus((status) => this.tray.update({ status }));
  }

  /** Connect once the daemon is reachable; the fake target has no daemon to link to. */
  async start(): Promise<void> {
    if (this.options.runtime.target.kind === "fake") return;
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
    this.backend = new BrowserBackend(link.channel(), this.views, {
      now: Date.now,
      onController: this.options.onController,
    });
    await link.start();
  }

  /** Route an alert and show it if the rules allow; true when shown. */
  alert(alert: Alert): boolean {
    const decision = this.router.route(alert);
    if (decision.kind === "show") this.notifier.show(decision.notification);
    return decision.kind === "show";
  }

  handBack(sessionId: string): void {
    this.backend?.handBack(sessionId);
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
  }

  async stop(): Promise<void> {
    this.backend?.shutdown();
    this.views.closeAll();
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
