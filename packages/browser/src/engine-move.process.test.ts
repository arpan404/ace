import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BrowserEngineMoved, type BrowserServerMessage } from "@ace/protocol";
import { BrowserService, connectBrowser, type EnginePreference } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { TabbedHeadless } from "./tabbed-test-support.ts";
import type { BrowserTabRecord, BrowserTabStore } from "./tab-store.ts";

/** A tab store as the daemon's SQLite one behaves, in memory: it outlives a daemon. */
function memoryTabs(): BrowserTabStore & { saved: Map<string, BrowserTabRecord[]> } {
  const saved = new Map<string, BrowserTabRecord[]>();
  return {
    saved,
    load: (threadId) => saved.get(threadId) ?? [],
    save: (threadId, tabs) => void saved.set(threadId, [...tabs]),
    clear: (threadId) => void saved.delete(threadId),
  };
}

/**
 * A daemon with the desktop app registered and ace's Chrome (with tabs), whose thread engine
 * setting starts as `kept` and whose tabs are kept in `tabs`, with the person's devices.
 */
async function machine(kept: EnginePreference | undefined) {
  const preferences = new Map<string, EnginePreference>();
  if (kept) preferences.set("thread", kept);
  const writes: EnginePreference[] = [];
  const headless = new TabbedHeadless();
  const tabs = memoryTabs();
  const backendPreference = (open: { threadId: string }) =>
    preferences.get(open.threadId) ?? "auto";
  const f = await backendFixture({ headlessBackend: headless, backendPreference, tabStore: tabs });
  const engine = {
    write: async (threadId: string, value: EnginePreference) => {
      writes.push(value);
      preferences.set(threadId, value);
    },
  };
  const device = (connectionId: string) => {
    const replies: BrowserServerMessage[] = [];
    const bridge = connectBrowser(f.service, {
      connectionId,
      authorize: () => true,
      send: (message) => {
        replies.push(message);
        return true;
      },
      engine,
    });
    return {
      async move(to: "embedded" | "headless") {
        const requestId = `${connectionId}-move`;
        await bridge.handle({
          type: "browser.engine.move",
          requestId,
          threadId: "thread",
          workspaceId: "workspace-thread",
          engine: to,
        });
        const reply = replies.find(
          (message) => message.type === "browser.result" && message.requestId === requestId,
        );
        if (reply?.type !== "browser.result") throw new Error("No reply");
        return reply;
      },
    };
  };
  const person = { kind: "human" as const, connectionId: "setup" };
  /** Opens the thread's browser with these pages, the first in the browser's own first tab. */
  const load = async (...urls: string[]) => {
    await f.open();
    const [first, ...rest] = urls;
    if (first)
      await f.service.execute("thread", { action: "navigate", url: first, timeout: 5_000 }, person);
    for (const url of rest)
      await f.service.execute("thread", { action: "tabs", operation: "open", url }, person);
  };
  /** Each tab as `url`, `url (shown)` or `url (private)`. */
  const pages = (service: BrowserService = f.service) => {
    const state = service.state("thread");
    const listed = state.tabs ?? [{ tabId: state.activeTabId, url: state.url, private: false }];
    return listed.map(
      (tab) =>
        `${tab.url}${tab.tabId === state.activeTabId ? " (shown)" : ""}${tab.private ? " (private)" : ""}`,
    );
  };
  const tabId = (url: string) =>
    f.service.state("thread").tabs?.find((tab) => tab.url === url)?.tabId ?? "";
  return {
    f,
    headless,
    tabs,
    preferences,
    writes,
    device,
    load,
    pages,
    tabId,
    person,
    backendPreference,
  };
}

it("two devices moving one thread at once end with one browser there and its pages loaded once", async () => {
  const m = await machine(undefined);
  await m.load("https://one.example/");
  expect(m.f.service.state("thread").backend).toBe("embedded");

  const [phone, web] = await Promise.all([
    m.device("phone").move("headless"),
    m.device("web").move("headless"),
  ]);

  expect(phone).toMatchObject({ ok: true });
  expect(web).toMatchObject({ ok: true });
  expect(m.f.service.state("thread")).toMatchObject({ backend: "headless", closed: false });
  // One headless browser opened, its page loaded there once.
  expect(m.headless.opens).toHaveLength(1);
  expect(m.headless.loads).toEqual(["https://one.example/"]);
  expect(m.pages()).toEqual(["https://one.example/ (shown)"]);
  expect(m.preferences.get("thread")).toBe("headless");
  expect(BrowserEngineMoved.parse(web.ok ? web.result : undefined).failed).toEqual([]);
});

it("a move to an engine that can't open brings every tab back where it was, the shown and private ones as they were", async () => {
  const m = await machine("headless");
  await m.load("https://one.example/", "https://two.example/", "https://three.example/");
  m.f.service.setPrivate("thread", m.tabId("https://two.example/"), true);
  await m.f.service.execute(
    "thread",
    { action: "tabs", operation: "select", tabId: m.tabId("https://two.example/") },
    m.person,
  );
  const before = m.pages();
  expect(before).toEqual([
    "https://one.example/",
    "https://two.example/ (shown) (private)",
    "https://three.example/",
  ]);
  m.f.failOpen("The desktop app has no window");

  const reply = await m.device("phone").move("embedded");

  expect(reply).toMatchObject({
    ok: false,
    error: expect.stringMatching(/stayed where it was\. .*no window/),
  });
  expect(m.f.service.state("thread")).toMatchObject({ backend: "headless", closed: false });
  expect(m.pages()).toEqual(before);
  // The setting was never changed, so there was nothing to put back.
  expect(m.writes).toEqual([]);
  expect(m.preferences.get("thread")).toBe("headless");
});

it("a daemon that stops mid-move opens the thread's tabs again on the engine it had", async () => {
  const m = await machine("headless");
  await m.load("https://one.example/", "https://two.example/");
  // The desktop never answers the new engine's open, so the move stops between close and reopen.
  m.f.hold("open");
  onTestFinished(() => m.f.releaseHold());
  const asked = once(m.f.requests, "open");
  void m.device("phone").move("embedded");
  await asked;
  expect(m.f.service.savedTabs("thread").map((tab) => tab.url)).toEqual([
    "https://one.example/",
    "https://two.example/",
  ]);

  // The daemon stops there; a new one starts on what was kept: the setting and the tab store.
  const home = await mkdtemp(join(tmpdir(), "ace-engine-restart-"));
  const headless = new TabbedHeadless();
  const restarted = new BrowserService({
    dataDir: home,
    headlessBackend: headless,
    backendPreference: m.backendPreference,
    tabStore: m.tabs,
  });
  onTestFinished(async () => {
    await restarted.close();
    await rm(home, { recursive: true, force: true });
  });
  await restarted.open({ threadId: "thread", workspaceId: "workspace-thread" });

  expect(restarted.state("thread")).toMatchObject({ backend: "headless", closed: false });
  expect(m.pages(restarted).map((page) => page.replace(" (shown)", ""))).toEqual([
    "https://one.example/",
    "https://two.example/",
  ]);
  expect(m.writes).toEqual([]);
});

it("a move queued behind one that failed still moves the browser, its page loaded there once", async () => {
  const m = await machine(undefined);
  await m.load("https://one.example/");
  m.headless.failOpen("Chrome didn't start");

  const [phone, web] = await Promise.all([
    m.device("phone").move("headless"),
    m.device("web").move("headless"),
  ]);

  expect(phone).toMatchObject({
    ok: false,
    error: expect.stringMatching(/stayed where it was\. Chrome didn't start/),
  });
  expect(web).toMatchObject({ ok: true });
  expect(m.f.service.state("thread")).toMatchObject({ backend: "headless", closed: false });
  expect(m.headless.loads).toEqual(["https://one.example/"]);
  expect(m.pages()).toEqual(["https://one.example/ (shown)"]);
  expect(m.writes).toEqual(["headless"]);
});

it("a thread without a browser keeps the choice for its next one and opens nothing", async () => {
  const m = await machine(undefined);

  const reply = await m.device("phone").move("headless");

  expect(reply).toMatchObject({ ok: true, result: { failed: [] } });
  expect(m.f.service.hasActiveSession("thread")).toBe(false);
  expect(m.writes).toEqual(["headless"]);
});
