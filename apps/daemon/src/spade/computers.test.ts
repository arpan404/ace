import { expect, test } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import {
  AgentId,
  ThreadId,
  WorkspaceId,
  type McpCapability,
  type SpadeComputerTab,
} from "@ace/protocol";
import { SpadeComputers, type BotThread } from "./computers.ts";

const spade = {
  threadId: ThreadId.parse("spade-host"),
  agentId: AgentId.parse("spade-root"),
  workspaceId: WorkspaceId.parse("spade-project"),
};

const lease = (threadId: ThreadId) =>
  new CredentialRegistry(() => "a".repeat(64)).issue(
    {
      sessionId: "session",
      threadId,
      agentId: AgentId.parse("root"),
      capabilities: ["browser", "screen", "thread_control"],
    },
    new AbortController().signal,
  ).principal;

/**
 * ace's tool registry with Spade's bots wired in as the daemon does, and two tools that report
 * the thread they ran as: a browser tool and a thread-control one. Browsers are a map of each
 * thread's tabs, as ace's browser service would hold them.
 */
function ace() {
  let clock = 1_000;
  const threads = new Map<string, BotThread>();
  const tabs = new Map<string, SpadeComputerTab[]>();
  const apps = new Map<string, string[]>();
  const computers = new SpadeComputers({
    host: () => spade,
    find: (key) => threads.get(key),
    create(_host, key) {
      const thread = {
        threadId: ThreadId.parse(`thread-${threads.size + 1}`),
        agentId: AgentId.parse(`agent-${threads.size + 1}`),
      };
      threads.set(key, thread);
      return thread;
    },
    tabs: (threadId) => tabs.get(threadId) ?? [],
    apps: (threadId) => apps.get(threadId) ?? [],
    now: () => clock,
  });
  const registry = new ToolRegistry({
    scheduler: { after: () => () => {} },
    actAs: (_tool, capability, caller, actingFor) => computers.actAs(capability, caller, actingFor),
  });
  const tool = (name: string, capability: McpCapability) =>
    registry.register({
      name,
      description: name,
      capability,
      timeoutMs: 1000,
      input: z.object({ bot: z.string().optional() }),
      output: z.object({ threadId: z.string() }),
      async run(_input, context) {
        return { threadId: context.caller.threadId };
      },
    });
  tool("browser_tabs", "browser");
  tool("screen_state", "screen");
  tool("thread_read", "thread_control");
  const call = async (
    name: string,
    options: { args?: object; actingFor?: string; from?: ThreadId } = {},
  ) => {
    const result = await registry.call(
      name,
      options.args ?? {},
      lease(options.from ?? spade.threadId),
      new AbortController().signal,
      options.actingFor ? { actingFor: options.actingFor } : {},
    );
    const text = z.object({ text: z.string() }).parse(result.content[0]).text;
    return result.isError
      ? { error: z.object({ code: z.string() }).parse(JSON.parse(text)).code }
      : { ran: z.object({ threadId: z.string() }).parse(JSON.parse(text)).threadId };
  };
  return {
    computers,
    call,
    tabs,
    apps,
    threadOf: (bot: string) => threads.get(`computer:${bot}`)?.threadId,
    advance: (ms: number) => void (clock += ms),
  };
}

test("a browser call Spade makes for a bot runs as that bot's own thread", async () => {
  const daemon = ace();
  const first = await daemon.call("browser_tabs", { actingFor: "fares" });
  expect(first.ran).toBe(daemon.threadOf("fares"));
  expect(first.ran).not.toBe(spade.threadId);
  // The same bot keeps the same thread, so it finds its tabs again.
  expect(await daemon.call("screen_state", { actingFor: "fares" })).toEqual(first);
});

test("a bot named in the tool's arguments changes nothing: only Spade's client names the bot", async () => {
  const daemon = ace();
  expect(await daemon.call("browser_tabs", { args: { bot: "fares" } })).toEqual({
    ran: spade.threadId,
  });
  expect(daemon.threadOf("fares")).toBeUndefined();
});

test("another thread's grant can't act as a bot by naming one", async () => {
  const daemon = ace();
  const other = ThreadId.parse("some-agent-thread");
  expect(await daemon.call("browser_tabs", { actingFor: "fares", from: other })).toEqual({
    ran: other,
  });
  expect(daemon.threadOf("fares")).toBeUndefined();
});

test("two bots get separate browsers, and each lists only its own tabs", async () => {
  const daemon = ace();
  const fares = await daemon.call("browser_tabs", { actingFor: "fares" });
  const news = await daemon.call("browser_tabs", { actingFor: "news" });
  expect(fares.ran).not.toBe(news.ran);
  daemon.tabs.set(fares.ran ?? "", [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }]);
  daemon.tabs.set(news.ran ?? "", [{ tabId: "t2", title: "News", url: "https://news.test/" }]);
  expect(daemon.computers.computer("fares").browser.tabs.map((tab) => tab.tabId)).toEqual(["t1"]);
  expect(daemon.computers.computer("news").browser.tabs.map((tab) => tab.tabId)).toEqual(["t2"]);
});

test("a bot's computer lists its tabs and the apps it is using, with when it began", async () => {
  const daemon = ace();
  expect(daemon.computers.computer("fares")).toEqual({
    bot: "fares",
    driver: "bot",
    browser: { tabs: [] },
    screen: { apps: [] },
  });
  const { ran } = await daemon.call("browser_tabs", { actingFor: "fares" });
  const threadId = ThreadId.parse(ran);
  daemon.tabs.set(threadId, [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }]);
  daemon.apps.set(threadId, ["Numbers"]);
  daemon.computers.appsChanged([{ threadId }]);
  expect(daemon.computers.computer("fares")).toEqual({
    bot: "fares",
    driver: "bot",
    threadId,
    browser: { tabs: [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }] },
    screen: { apps: ["Numbers"], since: 1_000 },
  });
});

test("while the person drives, the bot's browser and screen tools are refused, other tools are not", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  daemon.computers.drive("fares", "person");
  expect(await daemon.call("browser_tabs", { actingFor: "fares" })).toEqual({
    error: "person_driving",
  });
  expect(await daemon.call("screen_state", { actingFor: "fares" })).toEqual({
    error: "person_driving",
  });
  expect((await daemon.call("thread_read", { actingFor: "fares" })).ran).toBe(spade.threadId);
  // Another bot keeps working.
  expect((await daemon.call("browser_tabs", { actingFor: "news" })).ran).toBe(
    daemon.threadOf("news"),
  );
  daemon.computers.drive("fares", "bot");
  expect((await daemon.call("browser_tabs", { actingFor: "fares" })).ran).toBe(
    daemon.threadOf("fares"),
  );
});

test("handing back reports where the person went, the tabs they opened and closed, and the screen", async () => {
  const daemon = ace();
  const { ran } = await daemon.call("browser_tabs", { actingFor: "fares" });
  const threadId = ThreadId.parse(ran);
  const home = { tabId: "t1", title: "Fares", url: "https://fly.test/" };
  const old = { tabId: "t2", title: "Old", url: "https://old.test/" };
  daemon.tabs.set(threadId, [home, old]);
  expect(daemon.computers.drive("fares", "person")).toEqual({ driver: "person" });
  expect(daemon.computers.computer("fares").driver).toBe("person");
  const login = { ...home, title: "Sign in", url: "https://fly.test/login" };
  daemon.computers.browserChanged({ threadId, tabs: [login] });
  const booking = { tabId: "t3", title: "Booking", url: "https://fly.test/book" };
  daemon.tabs.set(threadId, [login, booking]);
  daemon.computers.browserChanged({ threadId, tabs: [login, booking] });
  daemon.computers.screenUsedBy(threadId);
  daemon.advance(180_000);
  expect(daemon.computers.drive("fares", "bot")).toEqual({
    driver: "bot",
    handback: {
      drivenMs: 180_000,
      visited: ["https://fly.test/login", "https://fly.test/book"],
      opened: [booking],
      closed: [old],
      screenUsed: true,
    },
  });
  // Handing back twice reports nothing new.
  expect(daemon.computers.drive("fares", "bot")).toEqual({ driver: "bot" });
});

test("another bot's browser changing never lands in a driven bot's hand-back", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  const news = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "news" })).ran);
  daemon.computers.drive("fares", "person");
  daemon.computers.browserChanged({
    threadId: news,
    tabs: [{ tabId: "n1", title: "News", url: "https://news.test/" }],
  });
  daemon.computers.screenUsedBy(news);
  expect(daemon.computers.drive("fares", "bot").handback).toMatchObject({
    visited: [],
    screenUsed: false,
  });
});
