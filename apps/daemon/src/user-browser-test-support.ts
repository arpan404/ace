import type { UserBrowserDaemonMessage, UserBrowserTab } from "@ace/protocol";
import type { UserChromeHub } from "@ace/browser";

export const clock = {
  now: () => performance.now(),
  set(delay: number, work: () => void) {
    const timer = setTimeout(work, delay);
    return () => clearTimeout(timer);
  },
};

/** One tab of the person's browser as the extension reports it. */
const userTab = (tabId: number, url: string, access: UserBrowserTab["access"]): UserBrowserTab => ({
  tabId,
  windowId: access === "agent" ? 2 : 1,
  url,
  title: access === "agent" ? "" : "Inbox",
  active: false,
  access,
  attached: access === "agent",
});

/**
 * The ace extension in the person's Chrome, as the daemon's link sees it (ADR 0084): it opens
 * agent tabs, attaches to tabs the person shared, and answers the CDP the sessions send.
 */
export function personsChrome(hub: UserChromeHub) {
  const tabs = new Map<number, UserBrowserTab>();
  const operations: UserBrowserDaemonMessage[] = [];
  let next = 1;
  const register = () => {
    const current = hub.register(
      { family: "chrome", version: "155", profileId: "profile", extensionVersion: "0.1.0" },
      {
        send(message) {
          operations.push(message);
          if (message.type === "user_browser.command")
            queueMicrotask(() => reply(message.id, message.operation));
          return true;
        },
        close() {},
      },
    );
    return current;
  };
  let link = register();
  const publish = () =>
    link.handle({ type: "user_browser.event", event: { kind: "tabs", tabs: [...tabs.values()] } });
  const event = (tabId: number, method: string, params: unknown) =>
    link.handle({ type: "user_browser.event", event: { kind: "cdp", tabId, method, params } });
  const cdp = (tabId: number, method: string, params?: Record<string, unknown>) => {
    const current = tabs.get(tabId);
    if (!current?.attached) throw new Error("Not attached");
    if (method === "Page.getLayoutMetrics")
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    if (method === "Page.captureScreenshot") return { data: "AA==" };
    if (method === "Runtime.evaluate") return { result: { value: 1 } };
    if (method === "Page.navigate") {
      const url = String(params?.["url"]);
      tabs.set(tabId, { ...current, url });
      event(tabId, "Page.frameNavigated", { frame: { id: `frame-${tabId}`, url } });
      // The extension reports a tab's new address as Chrome updates it.
      queueMicrotask(publish);
      return { frameId: `frame-${tabId}` };
    }
    return {};
  };
  const answer = (
    operation: Extract<UserBrowserDaemonMessage, { type: "user_browser.command" }>["operation"],
  ) => {
    switch (operation.op) {
      case "tabs.open": {
        const opened = userTab(100 + next++, "about:blank", "agent");
        tabs.set(opened.tabId, opened);
        publish();
        return opened;
      }
      case "tabs.attach": {
        const shared = tabs.get(operation.tabId);
        if (!shared) throw new Error("No such tab");
        const attached = { ...shared, attached: true };
        tabs.set(operation.tabId, attached);
        return attached;
      }
      case "tabs.close":
        tabs.delete(operation.tabId);
        publish();
        return {};
      case "cdp":
        return cdp(operation.tabId, operation.method, operation.params);
      default:
        return {};
    }
  };
  const reply = (id: string, operation: Parameters<typeof answer>[0]) => {
    try {
      link.handle({ type: "user_browser.reply", id, ok: true, result: answer(operation) });
    } catch (error) {
      link.handle({ type: "user_browser.reply", id, ok: false, error: String(error) });
    }
  };
  return {
    get link() {
      return link;
    },
    tabs,
    /**
     * The extension reconnects (a daemon restart, a dropped link): its agent tabs are still
     * open, detached, and the daemon gets a new link to the same browser profile.
     */
    reconnect() {
      for (const [tabId, tab] of tabs) tabs.set(tabId, { ...tab, attached: false });
      link = register();
      publish();
    },
    /** A page in an agent tab opened another tab; the extension made it an agent tab. */
    popup(openerTabId: number, url: string) {
      const tabId = 100 + next++;
      tabs.set(tabId, { ...userTab(tabId, url, "agent"), attached: false, openerTabId });
      publish();
      return tabId;
    },
    /** The person clicks "Share this tab with ace" on one of their own tabs. */
    share(tabId: number, url: string) {
      tabs.set(tabId, userTab(tabId, url, "shared"));
      publish();
    },
    ops: () =>
      operations.flatMap((message) =>
        message.type === "user_browser.command" ? [message.operation] : [],
      ),
  };
}
