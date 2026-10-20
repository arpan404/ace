import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BrowserService, type Actor, type BrowserBackend } from "@ace/browser";
import { groupViews } from "./test-support.ts";
import { connectDesktop, eventually, relayDaemon } from "./relay-test-support.ts";

/**
 * Idle native tabs (#1113): the daemon's lifecycle policy (ADR 0083) freezes and discards the
 * desktop's views (ADR 0085) through the real relay over a real local socket, with a fake clock.
 */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const noChrome: BrowserBackend = {
  kind: "headless",
  open: () => Promise.reject(new Error("ace's Chrome is not part of this test")),
};
const minute = 60_000;
const agent: Actor = { kind: "agent", agentId: "agent-a" };
const person = { kind: "human" as const, connectionId: "connection-1" };

async function idleNativeTabs() {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-relay-lifecycle-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  let now = 0;
  let check: (() => void) | undefined;
  const service = new BrowserService({
    dataDir,
    headlessBackend: noChrome,
    backendPreference: () => "embedded",
    now: () => now,
    // The thread's lifecycle check runs when the test says, not on a timer.
    tabLifecycle: {
      policy: { freezeAfterMs: 15 * minute, discardAfterMs: 120 * minute },
      every: minute,
      set: (_delay, work) => {
        check = work;
        return () => {
          if (check === work) check = undefined;
        };
      },
    },
    ffmpeg: "",
  });
  cleanups.push(() => service.close());
  const daemon = await relayDaemon(cleanups, {
    register: (_id, transport) => service.registerEmbedded(transport),
  });
  const views = groupViews();
  await connectDesktop(cleanups, daemon, views.host);
  await service.open({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" });
  const shown = service.state("t-1").activeTabId ?? "";
  // The person keeps their own tab; the agent works in a tab of its own, unseen.
  await service.execute("t-1", { action: "tabs", operation: "select", tabId: shown }, person);
  await service.execute("t-1", { action: "tabs", operation: "open", label: "docs" }, agent);
  const unseen = service.currentTab("t-1", agent).tabId;
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/docs" }, agent);
  expect(service.state("t-1").activeTabId).toBe(shown);
  const lifecycle = (tabId: string) =>
    service.state("t-1").tabs?.find((tab) => tab.tabId === tabId)?.lifecycle;
  const after = async (ms: number) => {
    now += ms;
    const run = check;
    check = undefined;
    run?.();
    await eventually(() => expect(check).toBeDefined());
  };
  return { service, views, daemon, shown, unseen, lifecycle, after };
}

const lifecycleCalls = (calls: { method: string; params: Record<string, unknown> }[]) =>
  calls.filter((call) => call.method === "Page.setWebLifecycleState").map((call) => call.params);

it("an unseen native tab nobody uses freezes after fifteen minutes and runs again before the agent's next command", async () => {
  const { service, views, shown, unseen, lifecycle, after } = await idleNativeTabs();
  await after(14 * minute);
  expect(lifecycle(unseen)).toBe("live");
  await after(minute);
  await eventually(() => expect(lifecycle(unseen)).toBe("frozen"));
  expect(lifecycleCalls(views.tab(unseen).calls)).toEqual([{ state: "frozen" }]);
  // The tab the person looks at never freezes.
  expect(lifecycle(shown)).toBe("live");
  expect(lifecycleCalls(views.tab(shown).calls)).toEqual([]);

  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/next" }, agent);
  const methods = views.tab(unseen).calls.map((call) => call.method);
  const thawed = methods.lastIndexOf("Page.setWebLifecycleState");
  expect(lifecycleCalls(views.tab(unseen).calls).at(-1)).toEqual({ state: "active" });
  expect(methods.lastIndexOf("Page.navigate")).toBeGreaterThan(thawed);
  expect(lifecycle(unseen)).toBe("live");
});

it("a native tab idle for two hours loses its view, stays listed at its address and reopens with the same id when the agent uses it", async () => {
  const { service, views, unseen, lifecycle, after } = await idleNativeTabs();
  const view = views.tab(unseen);
  await after(120 * minute);
  await eventually(() => expect(lifecycle(unseen)).toBe("discarded"));
  expect(view.closed).toBe(true);
  expect(service.state("t-1").tabs?.find((tab) => tab.tabId === unseen)).toMatchObject({
    url: "http://localhost:5173/docs",
  });

  // The agent reads the page: the tab comes back as itself, at its address.
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/docs#top" }, agent);
  const reopened = views.tab(unseen);
  expect(reopened).not.toBe(view);
  expect(reopened.calls.filter((call) => call.method === "Page.navigate")[0]?.params).toEqual({
    url: "http://localhost:5173/docs",
  });
  expect(reopened.url()).toBe("http://localhost:5173/docs#top");
  expect(lifecycle(unseen)).toBe("live");
  expect(service.currentTab("t-1", agent).tabId).toBe(unseen);
});

it("the person showing a discarded native tab reopens it at its address", async () => {
  const { service, views, unseen, lifecycle, after } = await idleNativeTabs();
  await after(120 * minute);
  await eventually(() => expect(lifecycle(unseen)).toBe("discarded"));
  await service.execute("t-1", { action: "tabs", operation: "select", tabId: unseen }, person);
  await eventually(() => expect(lifecycle(unseen)).toBe("live"));
  expect(service.state("t-1").activeTabId).toBe(unseen);
  expect(views.tab(unseen).url()).toBe("http://localhost:5173/docs");
});

it("a discarded native tab stays listed through a dropped link the desktop re-adopts", async () => {
  const { service, views, daemon, shown, unseen, lifecycle, after } = await idleNativeTabs();
  await after(120 * minute);
  await eventually(() => expect(lifecycle(unseen)).toBe("discarded"));
  const kept = views.tab(shown);
  daemon.drop();
  await eventually(() => expect(kept.adoptions).toBe(1));
  await eventually(() => expect(service.state("t-1").paused).toBeFalsy());
  expect(service.state("t-1").tabs?.map((tab) => [tab.tabId, tab.lifecycle])).toEqual([
    [shown, "live"],
    [unseen, "discarded"],
  ]);
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/after" }, agent);
  expect(views.tab(unseen).url()).toBe("http://localhost:5173/after");
  expect(lifecycle(unseen)).toBe("live");
});

it("a native tab an agent used lately stays live", async () => {
  const { service, unseen, lifecycle, after } = await idleNativeTabs();
  await after(10 * minute);
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/more" }, agent);
  await after(10 * minute);
  expect(lifecycle(unseen)).toBe("live");
});
