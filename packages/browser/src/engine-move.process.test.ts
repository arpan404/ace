import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BrowserEngineMoved, type BrowserServerMessage } from "@ace/protocol";
import { BrowserService, connectBrowser, type EnginePreference } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { TabbedHeadless } from "./tabbed-test-support.ts";
import type { BrowserTabRecord, BrowserTabStore, EngineMoveJournal } from "./tab-store.ts";

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

/** A move journal as the daemon's SQLite one behaves, in memory: it outlives a daemon. */
function memoryJournal(): EngineMoveJournal & { kept: Map<string, BrowserTabRecord[]> } {
  const kept = new Map<string, BrowserTabRecord[]>();
  return {
    kept,
    begin: (threadId, tabs) => void kept.set(threadId, [...tabs]),
    pending: (threadId) => kept.get(threadId),
    end: (threadId) => void kept.delete(threadId),
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
  const journal = memoryJournal();
  const backendPreference = (open: { threadId: string }) =>
    preferences.get(open.threadId) ?? "auto";
  const f = await backendFixture({
    headlessBackend: headless,
    backendPreference,
    tabStore: tabs,
    moveJournal: journal,
  });
  /** While set, a setting write waits here: the move stands between its reopen and its commit. */
  let held: PromiseWithResolvers<void> | undefined;
  /** While set, a setting write fails with this reason. */
  let refusing: string | undefined;
  const asked: string[] = [];
  const engine = {
    write: async (threadId: string, value: EnginePreference) => {
      asked.push(value);
      await held?.promise;
      if (refusing) throw new Error(refusing);
      writes.push(value);
      preferences.set(threadId, value);
    },
  };
  const refuseWrites = (reason: string) => {
    refusing = reason;
  };
  const holdWrites = () => {
    held = Promise.withResolvers<void>();
    const gate = held;
    return () => gate.resolve();
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
    journal,
    asked,
    holdWrites,
    refuseWrites,
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
  // Settled, the move keeps no copy of its own.
  expect(m.journal.pending("thread")).toBeUndefined();
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

it("a daemon that stops after the new engine saved fewer tabs, before the setting, reopens every tab where it was", async () => {
  const m = await machine("headless");
  await m.load("https://one.example/", "https://two.example/");
  const release = m.holdWrites();
  onTestFinished(release);

  // The desktop's single page takes one of the two: its session saves a shorter list.
  void m.device("phone").move("embedded");
  await expect.poll(() => m.asked).toEqual(["embedded"]);
  expect(m.f.service.state("thread").backend).toBe("embedded");
  await expect.poll(() => m.tabs.load("thread").length).toBeLessThan(2);

  // The daemon stops there; a new one starts on what was kept.
  const home = await mkdtemp(join(tmpdir(), "ace-engine-window-"));
  const restarted = new BrowserService({
    dataDir: home,
    headlessBackend: new TabbedHeadless(),
    backendPreference: m.backendPreference,
    tabStore: m.tabs,
    moveJournal: m.journal,
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
  // Back, the session keeps the tabs itself: the move's copy is gone.
  expect(m.journal.pending("thread")).toBeUndefined();
  expect(m.writes).toEqual([]);
});

it("a move whose setting can't be kept and whose old engine won't reopen keeps its tabs for the next start", async () => {
  const m = await machine("headless");
  await m.load("https://one.example/", "https://two.example/");
  // The move reaches the desktop, then its setting write fails and ace's Chrome won't reopen.
  m.refuseWrites("Settings are read-only");
  m.headless.failOpen("Chrome didn't start");

  const reply = await m.device("phone").move("embedded");

  expect(reply).toMatchObject({
    ok: false,
    error: expect.stringMatching(/Settings are read-only\. .*couldn't go back/),
  });
  // Nowhere to go back to: the browser stays on the desktop, the move's copy of the tabs kept.
  expect(m.f.service.state("thread")).toMatchObject({ backend: "embedded", closed: false });
  expect(m.journal.pending("thread")?.map((tab) => tab.url)).toEqual([
    "https://one.example/",
    "https://two.example/",
  ]);
  expect(m.preferences.get("thread")).toBe("headless");

  // The daemon restarts: the thread's browser opens on the engine its setting names, every tab.
  const home = await mkdtemp(join(tmpdir(), "ace-engine-double-"));
  const restarted = new BrowserService({
    dataDir: home,
    headlessBackend: new TabbedHeadless(),
    backendPreference: m.backendPreference,
    tabStore: m.tabs,
    moveJournal: m.journal,
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
  expect(m.journal.pending("thread")).toBeUndefined();
});

// With one page the desktop holds every tab the move carries, so only the setting tells it apart.
it.each([
  ["two pages", ["https://one.example/", "https://two.example/"]],
  ["one page", ["https://one.example/"]],
])(
  "retrying a move back while that engine still won't open keeps the original tabs for the next start (%s)",
  async (_name, urls) => {
    const m = await machine("headless");
    await m.load(...urls);
    // As above: the move reaches the desktop, its setting write fails, Chrome won't reopen.
    m.refuseWrites("Settings are read-only");
    m.headless.failOpen("Chrome didn't start");
    expect(await m.device("phone").move("embedded")).toMatchObject({ ok: false });
    expect(m.f.service.state("thread").backend).toBe("embedded");
    expect(m.preferences.get("thread")).toBe("headless");

    // The person asks for ace's Chrome again while it still won't start: the browser stays on
    // the desktop, which isn't where the setting points, so the move's copy of the tabs stays.
    m.headless.failOpen("Chrome didn't start");
    const retry = await m.device("web").move("headless");

    expect(retry).toMatchObject({ ok: false, error: expect.stringMatching(/stayed where it was/) });
    expect(m.f.service.state("thread").backend).toBe("embedded");
    expect(m.journal.pending("thread")?.map((tab) => tab.url)).toEqual(urls);

    const home = await mkdtemp(join(tmpdir(), "ace-engine-retry-"));
    const restarted = new BrowserService({
      dataDir: home,
      headlessBackend: new TabbedHeadless(),
      backendPreference: m.backendPreference,
      tabStore: m.tabs,
      moveJournal: m.journal,
    });
    onTestFinished(async () => {
      await restarted.close();
      await rm(home, { recursive: true, force: true });
    });
    await restarted.open({ threadId: "thread", workspaceId: "workspace-thread" });

    expect(restarted.state("thread")).toMatchObject({ backend: "headless", closed: false });
    expect(m.pages(restarted).map((page) => page.replace(" (shown)", ""))).toEqual(urls);
    expect(m.journal.pending("thread")).toBeUndefined();
  },
);

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
