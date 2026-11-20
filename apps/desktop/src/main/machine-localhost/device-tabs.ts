import { WebContentsView, type BaseWindow, type WebContents } from "electron";
import type { z } from "zod";
import type {
  DeviceTabGo,
  DeviceTabOpen,
  DeviceTabPlacement,
  DeviceTabState,
} from "../../shared/device-tabs.ts";
import { toWindowBounds } from "../browser/placement.ts";
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
  log(message: string): void;
}

interface Tab {
  tabId: string;
  machineId: string;
  view: WebContentsView;
  host: DeviceTabHost;
  failures: TunnelFailures;
  failure: DeviceTabState["failure"];
}

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
  private options: DeviceTabsOptions;

  constructor(options: DeviceTabsOptions) {
    this.options = options;
  }

  async open(request: z.output<typeof DeviceTabOpen>, host: DeviceTabHost): Promise<void> {
    const kept = this.tabs.get(request.tabId);
    if (kept && !kept.view.webContents.isDestroyed()) {
      if (kept.machineId !== request.machineId) throw new Error("That tab is another machine's");
      this.attach(kept, host);
      this.report(kept);
      return;
    }
    if (!webUrl(request.url)) throw new Error("A device tab opens web addresses only");
    if (this.tabs.size >= tabLimit) throw new Error("Too many device tabs are open");
    const machine = await this.options.sessions.get(request.machineId);
    const again = this.tabs.get(request.tabId);
    if (again) return this.open(request, host);
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
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.detach(tab);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  /** The renderer's window is gone: its device tabs close with it. */
  forgetHost(contentsId: number): void {
    for (const tab of this.tabs.values())
      if (tab.host.contents.isDestroyed() || tab.host.contents.id === contentsId)
        this.close(tab.tabId);
  }

  closeAll(): void {
    for (const tabId of this.tabs.keys()) this.close(tabId);
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
