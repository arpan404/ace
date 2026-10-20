import { UserBrowserTab, type UserBrowserDownload } from "@ace/protocol";
import type { BackendOpen, BrowserBackend } from "./backend.ts";
import type { UserChromeHub } from "./user-chrome-hub.ts";
import type { UserChromeLink } from "./user-chrome-link.ts";
import { userTabSession, type UserTabSession } from "./user-chrome-session.ts";

/** A tab in one connected browser: the browser's link id and the browser's own tab id. */
export interface UserTabRef {
  connectionId: string;
  tabId: number;
}

/**
 * The person's own browser as a backend, kind `user` (ADR 0084). `open` gives an agent a new
 * tab in the ace window of the most recently connected browser; `claim` attaches to a tab the
 * person shared. Tabs the person did not share are never reachable.
 */
export class UserChromeBackend implements BrowserBackend {
  readonly kind = "user";
  private hub: UserChromeHub;
  private platform: NodeJS.Platform;
  constructor(hub: UserChromeHub, platform: NodeJS.Platform) {
    this.hub = hub;
    this.platform = platform;
  }
  available(): boolean {
    return this.hub.preferred() !== undefined;
  }
  /** Whether the browser behind this link id is still connected. */
  connected(connectionId: string): boolean {
    const link = this.hub.get(connectionId);
    return link !== undefined && !link.closed;
  }
  /** Browsers connected or left, or the tabs the person shared changed. */
  onChange(listener: () => void): () => void {
    return this.hub.onChange(listener);
  }
  /** Tabs the person shared, in every connected browser. */
  sharedTabs(): (UserTabRef & { tab: UserBrowserTab })[] {
    return this.hub
      .connections()
      .flatMap((connection) =>
        connection.tabs
          .filter((tab) => tab.access === "shared")
          .map((tab) => ({ connectionId: connection.connectionId, tabId: tab.tabId, tab })),
      );
  }
  /**
   * Tabs an agent tab's page opened (popups), in every connected browser. The extension made
   * them agent tabs; the thread that owns the opener adopts them.
   */
  popups(): (UserTabRef & { openerTabId: number })[] {
    return this.hub.connections().flatMap((connection) =>
      connection.tabs.flatMap((tab) =>
        tab.access === "agent" && tab.openerTabId !== undefined
          ? [
              {
                connectionId: connection.connectionId,
                tabId: tab.tabId,
                openerTabId: tab.openerTabId,
              },
            ]
          : [],
      ),
    );
  }
  /**
   * Agent tabs in every connected browser. They outlive the daemon: after a restart a thread
   * takes back the ones it had instead of opening new ones.
   */
  agentTabs(): (UserTabRef & { tab: UserBrowserTab })[] {
    return this.hub
      .connections()
      .flatMap((connection) =>
        connection.tabs
          .filter((tab) => tab.access === "agent")
          .map((tab) => ({ connectionId: connection.connectionId, tabId: tab.tabId, tab })),
      );
  }
  /** The tab as its browser last listed it. */
  tab(ref: UserTabRef): UserBrowserTab | undefined {
    return this.hub
      .get(ref.connectionId)
      ?.tabs()
      .find((tab) => tab.tabId === ref.tabId);
  }
  /** Downloads the tab started, as the person's browser reports them. */
  onDownload(ref: UserTabRef, listener: (download: UserBrowserDownload) => void): () => void {
    return this.hub.get(ref.connectionId)?.onDownload(ref.tabId, listener) ?? (() => {});
  }
  /** The person turns a tab's sound off or on in their own browser. */
  async mute(ref: UserTabRef, muted: boolean): Promise<void> {
    const link = this.hub.get(ref.connectionId);
    if (!link) throw new Error("That browser is not connected to ace");
    await link.command({ op: "tabs.mute", tabId: ref.tabId, muted });
  }
  async open(request: BackendOpen): Promise<UserTabSession & { ref: UserTabRef }> {
    request.signal.throwIfAborted();
    const link = this.hub.preferred();
    if (!link) throw new Error("No browser is connected through Use my Chrome");
    const tab = UserBrowserTab.parse(await link.command({ op: "tabs.open" }, request.signal));
    const session = await this.start(link, tab, request);
    return Object.assign(session, { ref: { connectionId: link.connectionId, tabId: tab.tabId } });
  }
  /** Takes over a popup an agent tab opened; it is an agent tab, closed with its session. */
  async adopt(request: BackendOpen, ref: UserTabRef): Promise<UserTabSession> {
    request.signal.throwIfAborted();
    const link = this.hub.get(ref.connectionId);
    if (!link) throw new Error("That browser is not connected to ace");
    const tab = UserBrowserTab.parse(
      await link.command({ op: "tabs.attach", tabId: ref.tabId }, request.signal),
    );
    if (tab.access !== "agent") throw new Error("That tab is not an agent's");
    return this.start(link, tab, request);
  }
  async claim(request: BackendOpen, ref: UserTabRef): Promise<UserTabSession> {
    request.signal.throwIfAborted();
    const link = this.hub.get(ref.connectionId);
    if (!link) throw new Error("That browser is not connected to ace");
    const shared = link.tabs().find((tab) => tab.tabId === ref.tabId && tab.access === "shared");
    if (!shared) throw new Error("That tab is not shared with ace");
    const tab = UserBrowserTab.parse(
      await link.command({ op: "tabs.attach", tabId: ref.tabId }, request.signal),
    );
    return this.start(link, tab, request);
  }
  /** A failed start closes an agent's tab and detaches from a shared one. */
  private start(
    link: UserChromeLink,
    tab: UserBrowserTab,
    request: BackendOpen,
  ): Promise<UserTabSession> {
    return userTabSession(link, tab, request, this.platform);
  }
}
