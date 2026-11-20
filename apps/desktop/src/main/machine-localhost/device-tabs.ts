import { WebContentsView, type BaseWindow, type WebContents } from "electron";
import type { z } from "zod";
import type {
  DeviceTabGo,
  DeviceTabOpen,
  DeviceTabPlacement,
  DeviceTabState,
} from "../../shared/device-tabs.ts";
import { popupContextMenu } from "../browser/context-menu.ts";
import { openDevTools, printPage } from "../browser/devtools.ts";
import { toWindowBounds } from "../browser/placement.ts";
import { replayChord } from "../shortcuts.ts";
import { deviceTabKey, zoomedLevel, type DeviceTabKey } from "./device-keys.ts";
import { isLoopbackUrl } from "./loopback.ts";
import type { MachineSessions } from "./machine-sessions.ts";
import { loadFailure, type TunnelFailures } from "./tunnel-failure.ts";

/** The app window's renderer that holds a device tab. */
export interface DeviceTabHost {
  contents: WebContents;
  window: BaseWindow;
  zoom: number;
}

export interface DeviceTabsOptions {
  sessions: MachineSessions;
  state(host: WebContents, state: DeviceTabState): void;
  /** A link asked for a new tab: the renderer opens it as another device tab. */
  openTab(host: WebContents, request: { from: string; url: string }): void;
  /** Typing moves to the tab's address field (`CmdOrCtrl+L` in the page). */
  focusAddress(host: WebContents, request: { tabId: string }): void;
  /** Window `host`'s last device tab of the machine closed, or its open failed. */
  left(host: number, machineId: string): void;
  /** The machine's last device tab here closed, or its last open was given up. */
  idle(machineId: string): void;
  platform: NodeJS.Platform;
  log(message: string): void;
}

/** A tab whose view is still being made: its machine's partition is being set up. */
interface Opening {
  machineId: string;
  host: DeviceTabHost;
  cancelled: boolean;
  done: Promise<void>;
}

interface Tab {
  tabId: string;
  machineId: string;
  view: WebContentsView;
  host: DeviceTabHost;
  failures: TunnelFailures;
  failure: DeviceTabState["failure"];
}

/** The window's renderer id, or -1 once it is gone. */
const hostId = (host: DeviceTabHost) => (host.contents.isDestroyed() ? -1 : host.contents.id);

/** Device tabs this app keeps open at once. */
const tabLimit = 32;
const webUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * Device tabs (ADR 0194): pages the person opens on a remote machine's thread, each in a native
 * view on this computer, in its machine's partition. Agents never see or drive them. A tab
 * outlives a reload of the renderer that opened it (opening it again shows the same page,
 * unreloaded), and closes with its window.
 */
export class DeviceTabs {
  private tabs = new Map<string, Tab>();
  private opening = new Map<string, Opening>();
  private options: DeviceTabsOptions;

  constructor(options: DeviceTabsOptions) {
    this.options = options;
  }

  /**
   * Shows the tab's view in `host`'s window, making it first if it has none. Resolves once the
   * view exists, so placing it then finds it. A close (or the host going away) while the
   * machine's partition is set up gives the open up: it rejects and leaves no view behind.
   */
  async open(request: z.output<typeof DeviceTabOpen>, host: DeviceTabHost): Promise<void> {
    const kept = this.tabs.get(request.tabId);
    if (kept && !kept.view.webContents.isDestroyed()) {
      if (kept.machineId !== request.machineId) throw new Error("That tab is another machine's");
      this.attach(kept, host);
      this.report(kept);
      return;
    }
    const pending = this.opening.get(request.tabId);
    if (pending) {
      if (pending.machineId !== request.machineId) throw new Error("That tab is another machine's");
      pending.host = host;
      return pending.done;
    }
    if (!webUrl(request.url)) throw new Error("A device tab opens web addresses only");
    if (this.tabs.size + this.opening.size >= tabLimit)
      throw new Error("Too many device tabs are open");
    const opening: Opening = {
      machineId: request.machineId,
      host,
      cancelled: false,
      done: Promise.resolve(),
    };
    opening.done = this.make(request, opening).finally(() => {
      if (this.opening.get(request.tabId) === opening) this.opening.delete(request.tabId);
      this.settle(opening.host.contents, request.machineId);
    });
    this.opening.set(request.tabId, opening);
    return opening.done;
  }

  /** Whether any tab of the machine is open here, or being opened (in window `host`, if given). */
  holds(machineId: string, host?: number): boolean {
    const of = (each: { machineId: string; host: DeviceTabHost }) =>
      each.machineId === machineId && (host === undefined || hostId(each.host) === host);
    for (const tab of this.tabs.values()) if (of(tab)) return true;
    for (const opening of this.opening.values()) if (of(opening)) return true;
    return false;
  }

  /** After a tab of the machine went from window `host`: tells who is left holding it. */
  private settle(host: WebContents, machineId: string): void {
    const id = host.isDestroyed() ? undefined : host.id;
    if (id !== undefined && !this.holds(machineId, id)) this.options.left(id, machineId);
    if (!this.holds(machineId)) this.options.idle(machineId);
  }

  private async make(request: z.output<typeof DeviceTabOpen>, opening: Opening): Promise<void> {
    const machine = await this.options.sessions.get(request.machineId);
    const { host } = opening;
    if (opening.cancelled || host.contents.isDestroyed() || host.window.isDestroyed())
      throw new Error("The tab closed while it opened");
    const view = new WebContentsView({
      webPreferences: {
        partition: machine.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: true,
      },
    });
    view.setVisible(false);
    const tab: Tab = {
      tabId: request.tabId,
      machineId: request.machineId,
      view,
      host,
      failures: machine.failures,
      failure: undefined,
    };
    this.tabs.set(tab.tabId, tab);
    this.attach(tab, host);
    this.watch(tab);
    void view.webContents.loadURL(request.url).catch(() => {});
  }

  place(
    request: z.output<typeof DeviceTabPlacement>,
    host: DeviceTabHost,
  ): "shown" | "hidden" | "unavailable" {
    const tab = this.tabs.get(request.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return "unavailable";
    this.attach(tab, host);
    const bounds = toWindowBounds(request.bounds, host.zoom);
    const visible = request.visible && bounds.width > 0 && bounds.height > 0;
    if (visible) tab.view.setBounds(bounds);
    tab.view.setVisible(visible);
    return visible ? "shown" : "hidden";
  }

  go(request: z.output<typeof DeviceTabGo>): boolean {
    const tab = this.tabs.get(request.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    if (request.action === "navigate") {
      if (!webUrl(request.url)) return false;
      void contents.loadURL(request.url).catch(() => {});
    } else if (request.action === "back") {
      if (history.canGoBack()) history.goBack();
    } else if (request.action === "forward") {
      if (history.canGoForward()) history.goForward();
    } else if (request.action === "reload") contents.reload();
    else contents.stop();
    return true;
  }

  close(tabId: string): void {
    const opening = this.opening.get(tabId);
    if (opening) {
      opening.cancelled = true;
      this.opening.delete(tabId);
    }
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.detach(tab);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.settle(tab.host.contents, tab.machineId);
  }

  /** The renderer's window is gone: its device tabs close with it, opening ones included. */
  forgetHost(contentsId: number): void {
    const gone = (host: DeviceTabHost) =>
      host.contents.isDestroyed() || host.contents.id === contentsId;
    for (const [tabId, opening] of this.opening) if (gone(opening.host)) this.close(tabId);
    for (const tab of this.tabs.values()) if (gone(tab.host)) this.close(tab.tabId);
  }

  closeAll(): void {
    for (const tabId of [...this.opening.keys(), ...this.tabs.keys()]) this.close(tabId);
  }

  private attach(tab: Tab, host: DeviceTabHost): void {
    if (tab.host.window !== host.window) this.detach(tab);
    tab.host = host;
    if (!host.window.isDestroyed() && !host.window.contentView.children.includes(tab.view))
      host.window.contentView.addChildView(tab.view);
  }

  private detach(tab: Tab): void {
    const window = tab.host.window;
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
  }

  private watch(tab: Tab): void {
    const contents = tab.view.webContents;
    const report = () => this.report(tab);
    contents.on("did-start-loading", report);
    contents.on("did-stop-loading", report);
    contents.on("page-title-updated", report);
    contents.on("did-navigate-in-page", report);
    contents.on("did-navigate", () => {
      tab.failure = undefined;
      report();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.failure = loadFailure({ url, code, description, loopback: isLoopbackUrl(url) }, (port) =>
        tab.failures.recent(port),
      );
      report();
    });
    contents.on("before-input-event", (event, input) => {
      const key = deviceTabKey(input, this.options.platform);
      if (!key) return;
      event.preventDefault();
      if (input.type === "keyDown" && !input.isAutoRepeat) this.key(tab, key);
    });
    contents.on("context-menu", (_event, params) => {
      if (tab.host.window.isDestroyed()) return;
      popupContextMenu({
        window: tab.host.window,
        contents,
        params,
        // No agent sees a device tab, and its source opens nowhere ace shows.
        omit: ["annotate", "viewSource"],
        inspect: (at) => openDevTools(contents, at),
        app: (action, url) => {
          if (action === "openTab" && url && webUrl(url))
            this.options.openTab(tab.host.contents, { from: tab.tabId, url });
          else if (action === "back" || action === "forward" || action === "reload")
            this.go({ tabId: tab.tabId, action });
        },
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.options.log(`device tab: renderer gone (${details.reason})`);
      report();
    });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!webUrl(url)) return { action: "deny" };
      // A link to a new tab opens a device tab beside this one; a popup (a sign-in window that
      // talks back to its opener) opens as a window in the same partition.
      if (disposition === "foreground-tab" || disposition === "background-tab") {
        this.options.openTab(tab.host.contents, { from: tab.tabId, url });
        return { action: "deny" };
      }
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    });
  }

  /** A browser or app shortcut pressed while the tab's page has focus. */
  private key(tab: Tab, key: DeviceTabKey): void {
    const contents = tab.view.webContents;
    const host = tab.host.contents;
    if (contents.isDestroyed()) return;
    if (key.kind === "zoomIn" || key.kind === "zoomOut" || key.kind === "zoomReset")
      contents.setZoomLevel(zoomedLevel(contents.getZoomLevel(), key.kind));
    else if (key.kind === "print")
      void printPage(contents).catch((error: unknown) => this.options.log(String(error)));
    else if (key.kind === "devtools") openDevTools(contents);
    else if (key.kind === "reload" || key.kind === "back" || key.kind === "forward")
      this.go({ tabId: tab.tabId, action: key.kind });
    else if (key.kind === "address") {
      if (host.isDestroyed()) return;
      host.focus();
      this.options.focusAddress(host, { tabId: tab.tabId });
    } else if (key.kind === "app") {
      if (host.isDestroyed()) return;
      // The app page handles its own shortcut, as if the person had typed it there.
      host.focus();
      replayChord(host, key.accelerator, this.options.platform);
    }
  }

  private report(tab: Tab): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const history = contents.navigationHistory;
    this.options.state(tab.host.contents, {
      tabId: tab.tabId,
      url: contents.getURL().slice(0, 8192),
      title: contents.getTitle().slice(0, 1024),
      loading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      ...(tab.failure ? { failure: tab.failure } : {}),
    });
  }
}
