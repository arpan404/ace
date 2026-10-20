import type {
  UserBrowserDetachReason,
  UserBrowserExtensionMessage,
  UserBrowserOperation,
  UserBrowserTab,
} from "@ace/protocol";
import type { ChromeApi, ChromeTab, DebuggeeSource, DebuggerSession } from "./chrome-api.ts";
import { cdpAllowed, cdpNavigation, pageAllowed } from "./policy.ts";
import { DownloadReporter } from "./downloads.ts";

const groupTitle = "ace";
/** Out-of-process iframes one controlled tab may expose; more are left out of reach. */
const frameLimit = 64;
/** Child debugger sessions, flattened: each out-of-process iframe gets its own session id. */
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

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
  private attaching = new Map<number, Promise<void>>();
  /** An agent tab's popups: the popup's tab id to the agent tab whose page opened it. */
  private openers = new Map<number, number>();
  /** Each controlled tab's out-of-process iframe sessions. */
  private frames = new Map<number, Set<string>>();
  private aceWindow: number | undefined;
  private aceGroup: number | undefined;
  private linkState: ControllerState["link"] = "offline";
  private linkDetail: string | undefined;
  private listeners = new Set<() => void>();
  private downloads: DownloadReporter;
  constructor(chrome: ChromeApi, post: (message: UserBrowserExtensionMessage) => void) {
    this.chrome = chrome;
    this.post = post;
    this.downloads = new DownloadReporter(chrome, post, () => Date.now());
    chrome.debugger.onEvent.addListener((source, method, params) =>
      this.cdpEvent(source, method, params),
    );
    chrome.debugger.onDetach.addListener((source, reason) => this.debuggerDetached(source, reason));
    chrome.tabs.onCreated.addListener((tab) => void this.created(tab));
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
      case "tabs.mute":
        if (!this.shared.has(operation.tabId) && !this.agent.has(operation.tabId))
          throw new Error("That tab is not shared with ace");
        await this.chrome.tabs.update(operation.tabId, { muted: operation.muted });
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
        return this.cdp(operation.tabId, operation.method, operation.params, operation.sessionId);
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
      ...(this.openers.has(tabId) ? { openerTabId: this.openers.get(tabId) } : {}),
      audible: tab.audible ?? false,
      muted: tab.mutedInfo?.muted ?? false,
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
    await this.quiet(tabId);
    await this.group(tabId, tab.windowId);
    return this.attach(tabId);
  }
  /** Agents' tabs start muted: their pages never play over what the person is doing. */
  private async quiet(tabId: number): Promise<void> {
    await this.chrome.tabs.update(tabId, { muted: true }).catch(() => {});
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
      let attaching = this.attaching.get(tabId);
      if (!attaching) {
        attaching = this.debug(tabId).finally(() => this.attaching.delete(tabId));
        this.attaching.set(tabId, attaching);
      }
      await attaching;
    }
    await this.publish();
    return this.describe(tabId, await this.chrome.tabs.get(tabId));
  }
  /** Attaches the debugger to the tab; its frames follow with ace's first command. */
  private async debug(tabId: number): Promise<void> {
    await this.chrome.debugger.attach({ tabId }, "1.3");
    this.attached.add(tabId);
  }
  /**
   * Child sessions start with ace's first command on the tab, once ace listens: frames the page
   * already has are reported then. Without them (a browser before 125) cross-site frames stay
   * out of reach.
   */
  private async framesOn(tabId: number): Promise<void> {
    if (this.frames.has(tabId)) return;
    this.frames.set(tabId, new Set());
    await this.chrome.debugger
      .sendCommand({ tabId }, "Target.setAutoAttach", autoAttach)
      .catch(() => {});
  }
  /** A child session of a controlled tab appeared: only iframes are relayed to ace. */
  private childAttached(tabId: number, params: unknown): void {
    const child = childSession(params);
    const frames = this.frames.get(tabId);
    if (!child || !frames || child.type !== "iframe" || frames.size >= frameLimit) return;
    frames.add(child.sessionId);
    // A cross-site frame inside this one gets its own session too.
    void this.chrome.debugger
      .sendCommand({ tabId, sessionId: child.sessionId }, "Target.setAutoAttach", autoAttach)
      .catch(() => {});
  }
  private childDetached(tabId: number, params: unknown): void {
    const child = childSession(params);
    if (child) this.frames.get(tabId)?.delete(child.sessionId);
  }
  /** An agent tab's page opened a tab: it is the agents' too, in ace's group, controlled. */
  private async created(tab: ChromeTab): Promise<void> {
    const opener = tab.openerTabId;
    if (tab.id === undefined || opener === undefined) return;
    if (!this.agent.has(opener) || !this.attached.has(opener)) return;
    if (!pageAllowed(tab.pendingUrl || tab.url || "")) return;
    const tabId = tab.id;
    this.agent.add(tabId);
    this.openers.set(tabId, opener);
    await this.quiet(tabId);
    await this.group(tabId, tab.windowId);
    await this.attach(tabId).catch(async () => {
      this.agent.delete(tabId);
      this.openers.delete(tabId);
      await this.publish();
    });
  }
  private async cdp(
    tabId: number,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<unknown> {
    if (!this.attached.has(tabId)) throw new Error("That tab is not controlled by ace");
    if (sessionId !== undefined && !this.frames.get(tabId)?.has(sessionId))
      throw new Error("That frame is not controlled by ace");
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
    const target: DebuggerSession = sessionId === undefined ? { tabId } : { tabId, sessionId };
    const result = await this.chrome.debugger.sendCommand(target, method, params);
    await this.framesOn(tabId);
    return result;
  }
  private async detach(
    tabId: number,
    reason: UserBrowserDetachReason,
    report = true,
  ): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    this.frames.delete(tabId);
    await this.chrome.debugger.detach({ tabId }).catch(() => {});
    if (report)
      this.post({ type: "user_browser.event", event: { kind: "detached", tabId, reason } });
  }
  private async detachAll(reason: UserBrowserDetachReason): Promise<void> {
    await Promise.all([...this.attached].map((tabId) => this.detach(tabId, reason)));
  }
  private cdpEvent(source: DebuggeeSource, method: string, params: unknown): void {
    const { tabId, sessionId } = source;
    if (tabId === undefined || !this.attached.has(tabId)) return;
    if (method === "Target.attachedToTarget") this.childAttached(tabId, params);
    if (method === "Target.detachedFromTarget") this.childDetached(tabId, params);
    // Events of a child session ace does not control (a worker) stay here.
    if (sessionId !== undefined && !this.frames.get(tabId)?.has(sessionId)) return;
    if (sessionId === undefined) this.downloads.pageEvent(tabId, method, params);
    this.post({
      type: "user_browser.event",
      event: {
        kind: "cdp",
        tabId,
        ...(sessionId === undefined ? {} : { sessionId }),
        method,
        params: params ?? {},
      },
    });
  }
  private debuggerDetached(source: DebuggeeSource, reason: string): void {
    const tabId = source.tabId;
    if (tabId === undefined || !this.attached.delete(tabId)) return;
    this.frames.delete(tabId);
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
    this.openers.delete(tabId);
    this.frames.delete(tabId);
    if (this.attached.delete(tabId))
      this.post({
        type: "user_browser.event",
        event: { kind: "detached", tabId, reason: "closed" },
      });
    if (known) void this.publish();
  }
  private async updated(
    tabId: number,
    change: {
      url?: string;
      title?: string;
      groupId?: number;
      audible?: boolean;
      mutedInfo?: { muted: boolean };
    },
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
    } else if (
      change.url === undefined &&
      change.title === undefined &&
      change.audible === undefined &&
      change.mutedInfo === undefined
    )
      return;
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

/** A `Target.attachedToTarget` or `detachedFromTarget` event's session and target type. */
function childSession(params: unknown): { sessionId: string; type: string } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const sessionId: unknown = Reflect.get(params, "sessionId");
  const info: unknown = Reflect.get(params, "targetInfo");
  const type: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "type") : "";
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) return undefined;
  return { sessionId, type: typeof type === "string" ? type : "" };
}
