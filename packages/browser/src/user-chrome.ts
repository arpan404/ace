import { UserBrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserBackend, BrowserBackendSession } from "./backend.ts";
import type { UserChromeHub } from "./user-chrome-hub.ts";
import type { UserChromeLink } from "./user-chrome-link.ts";
import { userTabSession } from "./user-chrome-session.ts";

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
  async open(request: BackendOpen): Promise<BrowserBackendSession> {
    request.signal.throwIfAborted();
    const link = this.hub.preferred();
    if (!link) throw new Error("No browser is connected through Use my Chrome");
    const tab = UserBrowserTab.parse(await link.command({ op: "tabs.open" }, request.signal));
    return this.start(link, tab, request);
  }
  async claim(request: BackendOpen, ref: UserTabRef): Promise<BrowserBackendSession> {
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
  ): Promise<BrowserBackendSession> {
    return userTabSession(link, tab, request, this.platform);
  }
}
