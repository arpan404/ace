import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { Agent, AgentId } from "@ace/protocol";
import {
  BrowserService,
  TabBudget,
  UserChromeBackend,
  UserChromeHub,
  UserChromeTabsBackend,
  agentTabLimit,
  type Actor,
  type BrowserTabRecord,
  type BrowserTabStore,
} from "@ace/browser";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { watchBrowserTurns } from "./browser-turns.ts";
import { clock, personsChrome } from "./user-browser-test-support.ts";

const Opened = z.object({ tabId: z.string() });
const Listed = z.object({
  tabs: z.array(
    z.object({
      tabId: z.string(),
      openedBy: z.object({ kind: z.string(), agentId: z.string().optional() }).optional(),
    }),
  ),
});
const agent = (agentId: string): Actor => ({ kind: "agent", agentId });
const person: Actor = { kind: "human", connectionId: "person" };

/** The person's Chrome with the ace extension, and the daemon's sessions there (ADR 0084). */
async function usersChrome(options: { tabBudget?: TabBudget; tabStore?: BrowserTabStore } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-user-browser-lifecycle-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const hub = new UserChromeHub({ now: () => 1, clock });
  const chrome = personsChrome(hub);
  /** The daemon's sessions there; a restarted daemon makes new ones over the same browser. */
  const daemon = () => {
    const service = new BrowserService({
      dataDir: join(home, "user"),
      headlessBackend: new UserChromeTabsBackend(new UserChromeBackend(hub, process.platform)),
      backendPreference: () => "headless",
      tabLifecycle: false,
      ffmpeg: "",
      ...options,
    });
    onTestFinished(() => service.close());
    return service;
  };
  return { home, chrome, sessions: daemon(), daemon };
}
/** The daemon's database, as far as tabs go. */
function memoryTabs(): BrowserTabStore {
  const threads = new Map<string, BrowserTabRecord[]>();
  return {
    load: (threadId) => [...(threads.get(threadId) ?? [])],
    save: (threadId, tabs) => void threads.set(threadId, [...tabs]),
    clear: (threadId) => void threads.delete(threadId),
  };
}
const shape = (sessions: BrowserService) =>
  sessions
    .state("thread")
    .tabs?.map((tab) => ({ tabId: tab.tabId, url: tab.url, label: tab.label }));
/** One thread whose agent works in two labelled tabs of the person's Chrome. */
async function twoAgentTabs(sessions: BrowserService) {
  await sessions.open({ threadId: "thread", workspaceId: "workspace", background: true });
  await sessions.execute(
    "thread",
    { action: "navigate", url: "https://app.test/a" },
    agent("worker"),
  );
  await sessions.execute(
    "thread",
    { action: "tabs", operation: "open", url: "https://app.test/b", label: "b" },
    agent("worker"),
  );
  return shape(sessions);
}
const tabIds = (sessions: BrowserService, threadId: string) =>
  Listed.parse(sessions.state(threadId)).tabs.map((tab) => tab.tabId);

it("an agent's temporary tab in the person's Chrome closes when its turn ends; its kept tab stays", async () => {
  const { home, chrome, sessions } = await usersChrome();
  const store = new Store(join(home, "store.sqlite"));
  onTestFinished(() => store.close());
  const thread = createDevThread(store, store.createWorkspace(home, "Mine"));
  const root = AgentId.parse("root");
  store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: root,
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: home,
        status: { state: "working", activity: "tool" },
        createdAt: 1,
      }),
    },
  ]);
  onTestFinished(watchBrowserTurns(store, [sessions], (error) => console.error(error)));
  await sessions.open({ threadId: thread.id, workspaceId: thread.workspaceId, background: true });
  const first = sessions.state(thread.id).activeTabId;
  if (!first) throw new Error("No first tab");
  await sessions.execute(thread.id, { action: "tabs", operation: "select", tabId: first }, person);
  const open = async (extra: Record<string, unknown> = {}) =>
    Opened.parse(
      await sessions.execute(
        thread.id,
        { action: "tabs", operation: "open", url: "https://app.test/", ...extra },
        agent(root),
      ),
    ).tabId;
  const scratch = await open();
  const deliverable = await open({ keep: true });
  const agentTabsBefore = [...chrome.tabs.values()].filter((tab) => tab.access === "agent").length;

  // While the agent still works nothing closes; its turn ending closes the scratch tab.
  expect(tabIds(sessions, thread.id)).toContain(scratch);
  store.appendEvents(thread.id, [
    { type: "agent.status", agentId: root, status: { state: "idle" } },
  ]);
  await vi.waitFor(() => expect(tabIds(sessions, thread.id)).not.toContain(scratch));
  expect(tabIds(sessions, thread.id)).toEqual(expect.arrayContaining([first, deliverable]));
  expect([...chrome.tabs.values()].filter((tab) => tab.access === "agent")).toHaveLength(
    agentTabsBefore - 1,
  );
});

it("a popup past its agent's own tab limit is closed instead of adopted", async () => {
  const { chrome, sessions } = await usersChrome();
  await sessions.open({ threadId: "thread", workspaceId: "workspace", background: true });
  const own: string[] = [];
  for (let index = 0; index < agentTabLimit; index++)
    own.push(
      Opened.parse(
        await sessions.execute(
          "thread",
          { action: "tabs", operation: "open", url: "https://app.test/" },
          agent("worker"),
        ),
      ).tabId,
    );
  // The worker's last tab is the newest agent tab in the person's browser; its page opens one.
  const opener = Math.max(...chrome.tabs.keys());
  const popup = chrome.popup(opener, "https://app.test/popup");
  await vi.waitFor(() => expect(chrome.ops()).toContainEqual({ op: "tabs.attach", tabId: popup }));
  await vi.waitFor(() => expect(chrome.tabs.has(popup)).toBe(false));
  const workers = Listed.parse(sessions.state("thread")).tabs.filter(
    (tab) => tab.openedBy?.agentId === "worker",
  );
  expect(workers.map((tab) => tab.tabId)).toEqual(own);
});

it("tabs in the person's Chrome count against the daemon-wide tab budget", async () => {
  const tabBudget = new TabBudget(3);
  const { sessions } = await usersChrome({ tabBudget });
  await sessions.open({ threadId: "thread", workspaceId: "workspace", background: true });
  // ace's own browser holds the other two places.
  tabBudget.reserve();
  tabBudget.reserve();
  await expect(
    sessions.execute("thread", { action: "tabs", operation: "open" }, agent("worker")),
  ).rejects.toMatchObject({ code: "tab_limit" });
  expect(tabIds(sessions, "thread")).toHaveLength(1);
});

it("after its link drops, a thread takes back the agent tabs still open in the person's Chrome, with their ids", async () => {
  const { chrome, sessions } = await usersChrome({ tabStore: memoryTabs() });
  const had = await twoAgentTabs(sessions);
  expect(had).toHaveLength(2);
  chrome.reconnect();
  await vi.waitFor(() => expect(() => sessions.state("thread")).toThrow("not open"));
  const before = chrome.ops().length;
  await sessions.open({ threadId: "thread", workspaceId: "workspace", background: true });
  expect(shape(sessions)).toEqual(had);
  const since = chrome.ops().slice(before);
  expect(since).not.toContainEqual({ op: "tabs.open" });
  expect(since.filter((operation) => operation.op === "tabs.attach")).toHaveLength(2);
});

it("after a daemon restart, a thread's tabs in the person's Chrome reopen with their ids, addresses and labels", async () => {
  const { chrome, sessions, daemon } = await usersChrome({ tabStore: memoryTabs() });
  const had = await twoAgentTabs(sessions);
  await sessions.close();
  const restarted = daemon();
  await restarted.open({ threadId: "thread", workspaceId: "workspace", background: true });
  expect(shape(restarted)).toEqual(had);
  const open = [...chrome.tabs.values()].filter((tab) => tab.access === "agent");
  expect(open.map((tab) => tab.url).toSorted()).toEqual([
    "https://app.test/a",
    "https://app.test/b",
  ]);
});
