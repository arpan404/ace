import type {
  UserBrowserDetachReason,
  UserBrowserExtensionMessage,
  UserBrowserOperation,
  UserBrowserTab,
} from "@ace/protocol";
import type { ChromeApi, ChromeTab, DebuggeeSource } from "./chrome-api.ts";
import { cdpAllowed, cdpNavigation, pageAllowed } from "./policy.ts";

const groupTitle = "ace";

/** What the popup shows: the link to ace and every tab ace may touch. */
export interface ControllerState {
  link: "connecting" | "connected" | "unauthorized" | "unavailable" | "offline";
  detail?: string | undefined;
  tabs: UserBrowserTab[];
}

/**
 * The extension's whole policy and tab bookkeeping (ADR 0084): which tabs are shared, which an
 * agent opened, which have the debugger attached. Commands from ace act only on those tabs.
 */
export class Controller {
  private chrome: ChromeApi;
  private post: (message: UserBrowserExtensionMessage) => void;
  private shared = new Set<number>();
  private agent = new Set<number>();
  private attached = new Set<number>();
  private aceWindow: number | undefined;
  private aceGroup: number | undefined;
  private linkState: ControllerState["link"] = "offline";
  private linkDetail: string | undefined;
  private listeners = new Set<() => void>();
  constructor(chrome: ChromeApi, post: (message: UserBrowserExtensionMessage) => void) {
    this.chrome = chrome;
    this.post = post;
    chrome.debugger.onEvent.addListener((source, method, params) =>
      this.cdpEvent(source, method, params),
    );
    chrome.debugger.onDetach.addListener((source, reason) => this.debuggerDetached(source, reason));
    chrome.tabs.onRemoved.addListener((tabId) => this.removed(tabId));
    chrome.tabs.onUpdated.addListener((tabId, change) => void this.updated(tabId, change));
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The host's daemon link changed. Losing it ends every controlled tab: nothing drives them. */
  async link(state: ControllerState["link"], detail?: string): Promise<void> {
    this.linkState = state;
    this.linkDetail = detail;
    if (state !== "connected") await this.detachAll("unreachable");
    this.changed();
  }
  /** ace accepted this browser: it learns the current tabs. */
  async registered(): Promise<void> {
    await this.publish();
  }
  async state(): Promise<ControllerState> {
    return { link: this.linkState, detail: this.linkDetail, tabs: await this.tabs() };
  }
  async share(tabId: number): Promise<void> {
    const tab = await this.chrome.tabs.get(tabId);
    if (!pageAllowed(tab.url ?? "")) throw new Error("ace can't work on this page");
    this.shared.add(tabId);
    await this.publish();
  }
  async unshare(tabId: number): Promise<void> {
    this.shared.delete(tabId);
    if (!this.agent.has(tabId)) await this.detach(tabId, "revoked");
    await this.publish();
  }
  /** The person's Stop: every tab is released and every share forgotten. */
  async stop(): Promise<void> {
    await this.detachAll("stopped");
    this.shared.clear();
    this.agent.clear();
    await this.publish();
  }
  async command(operation: UserBrowserOperation): Promise<unknown> {
    switch (operation.op) {
      case "tabs.list":
        return this.tabs();
      case "tabs.open":
        return this.open(operation.url);
      case "tabs.attach":
        return this.attach(operation.tabId);
      case "tabs.detach":
        await this.detach(operation.tabId, "revoked", false);
        await this.publish();
        return null;
      case "tabs.close":
        if (!this.agent.has(operation.tabId)) throw new Error("ace closes only tabs it opened");
        await this.detach(operation.tabId, "closed", false);
        this.agent.delete(operation.tabId);
        await this.chrome.tabs.remove(operation.tabId).catch(() => {});
        await this.publish();
        return null;
      case "cdp":
        return this.cdp(operation.tabId, operation.method, operation.params);
      case "stop":
        await this.stop();
        return null;
    }
  }
  private async tabs(): Promise<UserBrowserTab[]> {
    const tabs: UserBrowserTab[] = [];
    for (const tabId of new Set([...this.shared, ...this.agent])) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => undefined);
      if (tab) tabs.push(this.describe(tabId, tab));
    }
    return tabs;
  }
  private describe(tabId: number, tab: ChromeTab): UserBrowserTab {
    return {
      tabId,
      windowId: tab.windowId,
      url: (tab.url || tab.pendingUrl || "").slice(0, 8192),
      title: (tab.title ?? "").slice(0, 1024),
      active: tab.active,
      access: this.agent.has(tabId) ? "agent" : "shared",
      attached: this.attached.has(tabId),
    };
  }
  /** A new agent tab in ace's own unfocused window, grouped as "ace". */
  private async open(url: string | undefined): Promise<UserBrowserTab> {
    if (url !== undefined && !pageAllowed(url)) throw new Error("ace can't open this page");
    const target = url ?? "about:blank";
    let tab: ChromeTab | undefined;
    if (this.aceWindow !== undefined) {
      const window = await this.chrome.windows.get(this.aceWindow).catch(() => undefined);
      if (window)
        tab = await this.chrome.tabs.create({
          windowId: this.aceWindow,
          url: target,
          active: true,
        });
    }
    if (!tab) {
      const window = await this.chrome.windows.create({ focused: false, url: target });
      this.aceWindow = window?.id;
      this.aceGroup = undefined;
      tab = window?.tabs?.[0];
    }
    if (tab?.id === undefined) throw new Error("Your browser did not open a tab");
    const tabId = tab.id;
    this.agent.add(tabId);
    await this.group(tabId, tab.windowId);
    return this.attach(tabId);
  }
  private async group(tabId: number, windowId: number): Promise<void> {
    if (!this.chrome.tabGroups) return;
    try {
      this.aceGroup = await this.chrome.tabs.group({
        tabIds: [tabId],
        ...(this.aceGroup === undefined
          ? { createProperties: { windowId } }
          : { groupId: this.aceGroup }),
      });
      await this.chrome.tabGroups.update(this.aceGroup, { title: groupTitle, color: "blue" });
    } catch {
      // Grouping is a label; a browser without tab groups still keeps agents in ace's window.
      this.aceGroup = undefined;
    }
  }
  private async attach(tabId: number): Promise<UserBrowserTab> {
    if (!this.shared.has(tabId) && !this.agent.has(tabId))
      throw new Error("That tab is not shared with ace");
    const tab = await this.chrome.tabs.get(tabId);
    if (!pageAllowed(tab.url || tab.pendingUrl || ""))
      throw new Error("ace can't work on this page");
    if (!this.attached.has(tabId)) {
      await this.chrome.debugger.attach({ tabId }, "1.3");
      this.attached.add(tabId);
    }
    await this.publish();
    return this.describe(tabId, await this.chrome.tabs.get(tabId));
  }
  private async cdp(
    tabId: number,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (!this.attached.has(tabId)) throw new Error("That tab is not controlled by ace");
    if (!cdpAllowed(method)) throw new Error(`ace for Chrome does not allow ${method}`);
    const navigation = cdpNavigation(method, params);
    if (navigation !== undefined && !pageAllowed(navigation))
      throw new Error("ace can't open this page");
    // Chrome paints only a window's active tab; agent tabs sit in ace's own window.
    if (
      this.agent.has(tabId) &&
      (method === "Page.captureScreenshot" || method === "Page.startScreencast")
    )
      await this.chrome.tabs.update(tabId, { active: true });
    return this.chrome.debugger.sendCommand({ tabId }, method, params);
  }
  private async detach(
    tabId: number,
    reason: UserBrowserDetachReason,
    report = true,
  ): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    await this.chrome.debugger.detach({ tabId }).catch(() => {});
    if (report)
      this.post({ type: "user_browser.event", event: { kind: "detached", tabId, reason } });
  }
  private async detachAll(reason: UserBrowserDetachReason): Promise<void> {
    await Promise.all([...this.attached].map((tabId) => this.detach(tabId, reason)));
  }
  private cdpEvent(source: DebuggeeSource, method: string, params: unknown): void {
    const tabId = source.tabId;
    if (tabId === undefined || source.sessionId !== undefined || !this.attached.has(tabId)) return;
    this.post({
      type: "user_browser.event",
      event: { kind: "cdp", tabId, method, params: params ?? {} },
    });
  }
  private debuggerDetached(source: DebuggeeSource, reason: string): void {
    const tabId = source.tabId;
    if (tabId === undefined || !this.attached.delete(tabId)) return;
    this.post({
      type: "user_browser.event",
      event: {
        kind: "detached",
        tabId,
        reason:
          reason === "canceled_by_user"
            ? "canceled"
            : reason === "target_closed"
              ? "closed"
              : "revoked",
      },
    });
    void this.publish();
  }
  private removed(tabId: number): void {
    const shared = this.shared.delete(tabId);
    const known = this.agent.delete(tabId) || shared;
    if (this.attached.delete(tabId))
      this.post({
        type: "user_browser.event",
        event: { kind: "detached", tabId, reason: "closed" },
      });
    if (known) void this.publish();
  }
  private async updated(
    tabId: number,
    change: { url?: string; title?: string; groupId?: number },
  ): Promise<void> {
    if (!this.shared.has(tabId) && !this.agent.has(tabId)) return;
    if (change.url !== undefined && !pageAllowed(change.url)) {
      await this.detach(tabId, "sensitive");
      this.shared.delete(tabId);
      this.agent.delete(tabId);
    } else if (
      change.groupId !== undefined &&
      this.agent.has(tabId) &&
      this.aceGroup !== undefined &&
      change.groupId !== this.aceGroup
    ) {
      // Dragged out of ace's group: the tab is the person's now.
      this.agent.delete(tabId);
      await this.detach(tabId, "revoked");
    } else if (change.url === undefined && change.title === undefined) return;
    await this.publish();
  }
  private async publish(): Promise<void> {
    const tabs = await this.tabs();
    const controlled = tabs.filter((tab) => tab.attached).length;
    void this.chrome.action.setBadgeText({ text: controlled ? String(controlled) : "" });
    if (this.linkState === "connected")
      this.post({ type: "user_browser.event", event: { kind: "tabs", tabs } });
    this.changed();
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
