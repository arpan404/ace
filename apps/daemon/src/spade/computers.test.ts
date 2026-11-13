import { expect, test } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { ace, spade } from "./computers-test-support.ts";
import { ScreenCowork } from "@ace/screen";
import { ComputerUsingThreads } from "../computer-using.ts";
import { nativeScreenPersonActive, watchNativeScreenUse } from "../services/spade-computers.ts";
import { SpadeComputers } from "./computers.ts";
import { memoryTakeovers } from "./computer-drivers.ts";
import type { SurfaceReport } from "./computer-reports.ts";

test("a browser call Spade makes for a bot runs as that bot's own thread", async () => {
  const daemon = ace();
  const first = await daemon.call("browser_tabs", { actingFor: "fares" });
  expect(first.ran).toBe(daemon.threadOf("fares"));
  expect(first.ran).not.toBe(spade.threadId);
  // The same bot keeps the same thread, so it finds its tabs again.
  expect(await daemon.call("screen_state", { actingFor: "fares" })).toEqual(first);
});

test("a simulator call Spade makes for a bot runs as that bot's thread too", async () => {
  const daemon = ace();
  const browser = await daemon.call("browser_tabs", { actingFor: "fares" });
  expect(await daemon.call("sim_act", { actingFor: "fares" })).toEqual(browser);
  expect((await daemon.call("sim_act", { actingFor: "news" })).ran).toBe(daemon.threadOf("news"));
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

test("a bot's computer lists its tabs, in ace's browser and the person's Chrome, and its apps", async () => {
  const daemon = ace();
  expect(daemon.computers.computer("fares")).toEqual({
    bot: "fares",
    driver: "bot",
    mode: "cowork",
    browser: { tabs: [] },
    screen: { apps: [] },
  });
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const mine = { tabId: "u1", title: "Bank", url: "https://bank.test/", backend: "user" as const };
  daemon.tabs.set(threadId, [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }, mine]);
  daemon.apps.set(threadId, ["Numbers"]);
  daemon.computers.appsChanged([{ threadId, apps: ["Numbers"] }]);
  expect(daemon.computers.computer("fares")).toEqual({
    bot: "fares",
    driver: "bot",
    mode: "cowork",
    threadId,
    browser: { tabs: [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }, mine] },
    screen: { apps: ["Numbers"], since: 1_000 },
  });
});

test("while the person drives, the bot's browser, screen and simulator tools are refused, other tools are not", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  await daemon.computers.drive("fares", "person");
  for (const tool of ["browser_tabs", "screen_state", "sim_act"])
    expect(await daemon.call(tool, { actingFor: "fares" })).toEqual({ error: "person_driving" });
  expect((await daemon.call("thread_read", { actingFor: "fares" })).ran).toBe(spade.threadId);
  // Another bot keeps working.
  expect((await daemon.call("browser_tabs", { actingFor: "news" })).ran).toBe(
    daemon.threadOf("news"),
  );
  await daemon.computers.drive("fares", "bot");
  expect((await daemon.call("browser_tabs", { actingFor: "fares" })).ran).toBe(
    daemon.threadOf("fares"),
  );
});

test("Spade hears when a bot's browser or screen changes, once per change, and who acted", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const tab = { tabId: "t1", title: "Fares", url: "https://fly.test/" };
  daemon.tabs.set(threadId, [tab]);
  daemon.computers.browserChanged({ threadId, activeTabId: "t1" });
  daemon.computers.browserChanged({ threadId, activeTabId: "t1" });
  daemon.computers.appsChanged([{ threadId, apps: ["Numbers"] }]);
  daemon.computers.appsChanged([]);
  // Another thread's browser is nobody's computer.
  daemon.computers.browserChanged({ threadId: ThreadId.parse("other") });
  expect(daemon.reports).toEqual([
    {
      bot: "fares",
      kind: "browser",
      live: true,
      title: "Fares",
      url: "https://fly.test/",
      tab_id: "t1",
      thread_id: threadId,
      mode: "cowork",
      person_active: false,
    },
    {
      bot: "fares",
      kind: "screen",
      live: true,
      title: "Numbers",
      thread_id: threadId,
      mode: "cowork",
      person_active: false,
    },
    {
      bot: "fares",
      kind: "screen",
      live: false,
      thread_id: threadId,
      mode: "cowork",
      person_active: false,
    },
  ]);
  daemon.reports.length = 0;
  await daemon.computers.drive("fares", "person");
  expect(daemon.reports).toEqual([
    expect.objectContaining({ kind: "browser", live: true, person_acted: true }),
    expect.objectContaining({ kind: "screen", live: false, person_acted: true }),
  ]);
});

test("a tab in the person's own Chrome is reported with its backend", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  daemon.tabs.set(threadId, [
    { tabId: "u1", title: "Bank", url: "https://bank.test/", backend: "user" },
  ]);
  daemon.computers.browserChanged({ threadId });
  expect(daemon.reports).toEqual([
    expect.objectContaining({ kind: "browser", tab_id: "u1", backend: "user" }),
  ]);
});

test("the tab reported is the one the browser is on, in its own backend, when ids are equal", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  daemon.tabs.set(threadId, [
    { tabId: "t1", title: "Fares", url: "https://fly.test/" },
    { tabId: "t1", title: "Bank", url: "https://bank.test/", backend: "user" },
    { tabId: "t2", title: "Other", url: "https://other.test/" },
  ]);
  // The person's Chrome changed and is on its t1.
  daemon.computers.browserChanged({ threadId, activeTabId: "t1" }, "user");
  expect(daemon.reports.at(-1)).toMatchObject({
    url: "https://bank.test/",
    tab_id: "t1",
    backend: "user",
  });
  // ace's browser changed and is on its own t1.
  daemon.computers.browserChanged({ threadId, activeTabId: "t1" });
  expect(daemon.reports.at(-1)).toMatchObject({ url: "https://fly.test/", tab_id: "t1" });
  expect(daemon.reports.at(-1)).not.toHaveProperty("backend");
});

test("in cowork Spade hears and reads where the person is active on a bot's computer", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  daemon.tabs.set(threadId, [
    { tabId: "t1", title: "Fares", url: "https://fly.test/", personActive: true },
  ]);
  daemon.computers.browserChanged({ threadId, activeTabId: "t1" });
  daemon.apps.set(threadId, ["Numbers"]);
  daemon.screenActive.add(threadId);
  daemon.computers.screenChanged({
    sessionId: "s1",
    lifecycle: "live",
    controller: "agent",
    holder: { threadId },
  });
  expect(daemon.reports).toEqual([
    expect.objectContaining({
      kind: "browser",
      mode: "cowork",
      person_active: true,
      person_acted: true,
    }),
    expect.objectContaining({
      kind: "screen",
      mode: "cowork",
      person_active: true,
      person_acted: true,
    }),
  ]);
  const computer = daemon.computers.computer("fares");
  expect(computer).toMatchObject({ mode: "cowork", screen: { personActive: true } });
  expect(computer.browser.tabs[0]?.personActive).toBe(true);
});

test("native app cowork activity reaches Spade get and reports without a live-view session", () => {
  let now = 1_000;
  const timers = new Set<{ at: number; run: () => void }>();
  const after = (ms: number, run: () => void) => {
    const timer = { at: now + ms, run };
    timers.add(timer);
    return () => void timers.delete(timer);
  };
  const using = new ComputerUsingThreads({ after });
  const cowork = new ScreenCowork({ clock: { now: () => now, set: after } });
  const threadId = ThreadId.parse("native-bot-thread");
  const other = ThreadId.parse("other-bot-thread");
  const reports: SurfaceReport[] = [];
  const computers = new SpadeComputers({
    host: () => spade,
    find: (key) =>
      key === "computer:fares"
        ? { threadId, agentId: AgentId.parse("native-bot-agent") }
        : undefined,
    create: () => undefined,
    tabs: () => [],
    apps: (id) => using.threads().find((entry) => entry.threadId === id)?.apps ?? [],
    activeTab: () => undefined,
    screenPersonActive: (id) => nativeScreenPersonActive(id, using, cowork),
    botOf: (id) => (id === threadId ? "fares" : undefined),
    report: (_bot, kind, report) => {
      if (kind === "screen") reports.push(report);
    },
    takeovers: memoryTakeovers(),
    after,
    now: () => now,
  });
  const stopUsing = using.subscribe((threads) => computers.appsChanged(threads));
  const stopCowork = watchNativeScreenUse(using, cowork, computers);
  const done = using.begin(threadId, "Numbers", "com.apple.iWork.Numbers");
  using.begin(other, "Calculator", "com.apple.calculator");

  cowork.personInput(["com.apple.calculator"]);
  expect(computers.computer("fares").screen.personActive).toBeUndefined();
  expect(reports.at(-1)).not.toHaveProperty("person_acted");
  cowork.personInput(["com.apple.iWork.Numbers"]);
  expect(computers.computer("fares").screen).toMatchObject({
    apps: ["Numbers"],
    personActive: true,
  });
  expect(reports.at(-1)).toMatchObject({
    mode: "cowork",
    title: "Numbers",
    person_active: true,
    person_acted: true,
  });

  now += 3_000;
  for (const timer of timers) {
    if (timer.at <= now && timers.delete(timer)) timer.run();
  }
  expect(computers.computer("fares").screen.personActive).toBeUndefined();
  expect(reports.at(-1)).toHaveProperty("person_active", false);
  expect(reports.at(-1)).not.toHaveProperty("person_acted");
  expect(computers.computer("fares").screen.apps).toEqual(["Numbers"]);
  done();
  stopCowork();
  stopUsing();
});
