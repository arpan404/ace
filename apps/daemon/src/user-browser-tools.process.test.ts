import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { Agent, AgentId, type UserBrowserDaemonMessage, type UserBrowserTab } from "@ace/protocol";
import {
  BrowserService,
  UserChromeBackend,
  UserChromeHub,
  UserChromeTabsBackend,
  type BrowserBackend,
} from "@ace/browser";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

const clock = {
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
function personsChrome(hub: UserChromeHub) {
  const tabs = new Map<number, UserBrowserTab>();
  const operations: UserBrowserDaemonMessage[] = [];
  let next = 1;
  const link = hub.register(
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
    link,
    tabs,
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

it("browser user calls run in the person's Chrome, list their shared tabs, and never fall back to ace's browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-user-browser-tools-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "store.sqlite"));
  onTestFinished(() => store.close());
  const thread = createDevThread(store, store.createWorkspace(home, "Mine"));
  store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: home,
        status: { state: "idle" },
        createdAt: 1,
      }),
    },
  ]);
  // ace's own browser: any page opened here would be a fallback.
  const aceOpens: string[] = [];
  const aceChrome: BrowserBackend = {
    kind: "headless",
    open: async (request) => {
      aceOpens.push(request.options.threadId);
      throw new Error("ace's browser must not be used here");
    },
  };
  const browser = new BrowserService({ dataDir: join(home, "ace"), headlessBackend: aceChrome });
  onTestFinished(() => browser.close());
  const hub = new UserChromeHub({ now: () => 1, clock });
  const user = new UserChromeBackend(hub, process.platform);
  const sessions = new BrowserService({
    dataDir: join(home, "user"),
    headlessBackend: new UserChromeTabsBackend(user),
    backendPreference: () => "headless",
    tabLifecycle: false,
    ffmpeg: "",
  });
  onTestFinished(() => sessions.close());
  const mcp = await startDaemonMcp(store, [
    browserToolkit(browser, store, undefined, { sessions, available: () => user.available() }),
  ]);
  onTestFinished(() => mcp.close());
  const lease = mcp.openSession(
    {
      sessionId: "root",
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  const call = async (name: string, args: unknown = {}) => {
    const result = Result.parse(
      await (await invoke({ url: mcp.url, bearer: lease.bearer }, name, args)).json(),
    ).result;
    const text = result.content[0]?.text ?? "null";
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as unknown;
  };

  // No browser connected: the call says so instead of using ace's browser.
  await expect(call("browser_open", { browser: "user" })).rejects.toThrow("not connected to ace");
  const chrome = personsChrome(hub);
  chrome.share(7, "https://mail.test/");

  const opened = z
    .object({ tabId: z.string() })
    .parse(await call("browser_open", { browser: "user", url: "https://app.test/" }));
  expect(chrome.ops()).toContainEqual({ op: "tabs.open" });
  expect([...chrome.tabs.values()]).toContainEqual(
    expect.objectContaining({ access: "agent", url: "https://app.test/" }),
  );
  const listed = z
    .object({
      tabs: z.array(
        z.object({
          tabId: z.string(),
          url: z.string(),
          openedBy: z.object({ kind: z.string() }).optional(),
        }),
      ),
    })
    .parse(await call("browser_tabs", { browser: "user", action: "list" }));
  const shared = listed.tabs.find((tab) => tab.url === "https://mail.test/");
  expect(shared?.openedBy).toEqual({ kind: "human" });
  expect(listed.tabs.map((tab) => tab.tabId)).toContain(opened.tabId);
  // Listing never takes the person's tab; the first command on it does.
  expect(chrome.ops()).not.toContainEqual({ op: "tabs.attach", tabId: 7 });
  await call("browser_open", {
    browser: "user",
    tabId: shared?.tabId,
    url: "https://mail.test/inbox",
  });
  expect(chrome.ops()).toContainEqual({ op: "tabs.attach", tabId: 7 });
  expect(chrome.tabs.get(7)?.url).toBe("https://mail.test/inbox");

  // The person's browser goes away: the thread's session there closes and stays closed.
  chrome.link.close("Your browser disconnected from ace");
  await vi.waitFor(() => expect(() => sessions.state(thread.id)).toThrow("not open"));
  await expect(call("browser_snapshot", { browser: "user" })).rejects.toThrow(
    "not connected to ace",
  );
  expect(aceOpens).toEqual([]);
});
