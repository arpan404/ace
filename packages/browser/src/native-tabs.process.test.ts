import { expect, it } from "vitest";
import type { BrowserBackendRequest } from "@ace/protocol";
import { z } from "zod";
import { backendFixture } from "./backend-test-support.ts";

const tabs = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    tabId: `tab-${index + 1}`,
    url: `https://example.test/${index + 1}`,
    title: `Tab ${index + 1}`,
  }));

const Logs = z.object({ entries: z.array(z.object({ text: z.string() })) });

/**
 * The desktop reports `count` new tabs, the second shown, and leaves each new tab's setup
 * (`Log.enable`, its last step) unanswered until the test answers it.
 */
async function tabsStillSettingUp(count: number) {
  const { f, sessionId } = await nativeSession();
  const setups: BrowserBackendRequest[] = [];
  f.requests.on("Log.enable", (request: BrowserBackendRequest) => setups.push(request));
  f.hold("Log.enable");
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-2", tabs: tabs(count) });
  await expect.poll(() => setups.length).toBe(count);
  expect(f.service.state("thread").activeTabId).toBe("tab-2");
  const answer = (request: BrowserBackendRequest, error?: string) =>
    f.desktop.send(
      JSON.stringify({
        type: "browser.backend.response",
        backendId: f.backend.id,
        sessionId: request.sessionId,
        id: request.id,
        ...(error ? { error } : { result: {} }),
      }),
    );
  return { f, sessionId, setups, answer };
}

/** Whether a promise is still pending after the event loop has had a few turns. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
  return !settled;
}

async function nativeSession() {
  const f = await backendFixture({}, { nativeTabs: true });
  await f.open();
  const sessionId = f.pages.keys().next().value;
  if (!sessionId) throw new Error("No native page");
  return { f, sessionId };
}

it("tab changes stay in sync with 12 open tabs", async () => {
  const { f, sessionId } = await nativeSession();
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-12", tabs: tabs(12) });
  await expect.poll(() => f.service.state("thread").tabs?.length).toBe(12);
  expect(f.service.state("thread").activeTabId).toBe("tab-12");
  expect(f.service.state("thread").url).toBe("https://example.test/12");

  // Closing one of many tabs and switching to another is still reflected.
  const remaining = tabs(12).filter((tab) => tab.tabId !== "tab-12");
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-3", tabs: remaining });
  await expect.poll(() => f.service.state("thread").activeTabId).toBe("tab-3");
  expect(f.service.state("thread").tabs?.map((tab) => tab.tabId)).toEqual(
    remaining.map((tab) => tab.tabId),
  );
});

it("a malformed tab entry is skipped and reported while the other tabs stay in sync", async () => {
  const { f, sessionId } = await nativeSession();
  const longUrl = `https://example.test/${"a".repeat(9000)}`;
  f.sendEvent(sessionId, "ace.tabs.changed", {
    activeTabId: "tab-2",
    tabs: [
      ...tabs(10),
      { url: "https://example.test/no-id", title: "No id" },
      { tabId: "long", url: longUrl, title: "Long" },
    ],
  });
  await expect.poll(() => f.service.state("thread").tabs?.length).toBe(11);
  const state = f.service.state("thread");
  expect(state.activeTabId).toBe("tab-2");
  expect(state.tabs?.find((tab) => tab.tabId === "long")?.url).toBe(longUrl.slice(0, 8192));
  const logs = Logs.parse(await f.service.execute("thread", { action: "logs" }));
  expect(logs.entries.some((entry) => entry.text.includes("malformed and skipped"))).toBe(true);
});

it("a command sent while the shown tab is still being set up runs on it once it is ready", async () => {
  const { f, setups, answer } = await tabsStillSettingUp(2);
  // Sent once, right after the list changed: no retry by the caller.
  const logs = f.service.execute("thread", { action: "logs" });
  expect(await pending(logs)).toBe(true);
  f.releaseHold();
  for (const setup of setups) answer(setup);
  expect(Logs.safeParse(await logs).success).toBe(true);
  expect(f.service.state("thread").activeTabId).toBe("tab-2");
});

it("a command waiting for a tab that closes before it is ready fails as not found, on no other tab", async () => {
  const { f, sessionId, setups, answer } = await tabsStillSettingUp(2);
  const logs = f.service.execute("thread", { action: "logs" });
  const refused = expect(logs).rejects.toMatchObject({ code: "tab_not_found" });
  expect(await pending(logs)).toBe(true);
  // The person closes the tab the command was for; the other one is still setting up.
  f.sendEvent(sessionId, "ace.tabs.changed", { activeTabId: "tab-1", tabs: tabs(1) });
  await refused;
  f.releaseHold();
  for (const setup of setups) answer(setup);
});

it("a command waiting for a tab whose setup fails gets that failure, on no other tab", async () => {
  const { f, setups, answer } = await tabsStillSettingUp(2);
  const logs = f.service.execute("thread", { action: "logs" });
  const refused = expect(logs).rejects.toMatchObject({ code: "backend_changed" });
  expect(await pending(logs)).toBe(true);
  f.releaseHold();
  const [first, second] = setups;
  if (!first || !second) throw new Error("Both tabs started their setup");
  answer(second, "Target closed");
  answer(first);
  await refused;
});

it("more than eight threads can hold a browser page at the same time", async () => {
  const f = await backendFixture();
  const opened = await Promise.all(
    Array.from({ length: 12 }, (_, index) => f.open(`thread-${index}`)),
  );
  expect(opened.every((state) => !state.closed)).toBe(true);
  expect(f.pages.size).toBe(12);
});

it("an agent can give a navigation two minutes to load", async () => {
  const { f } = await nativeSession();
  const state = await f.service.execute(
    "thread",
    { action: "navigate", url: "http://localhost:3000/slow", timeout: 120_000 },
    { kind: "agent" },
  );
  expect(z.object({ url: z.string() }).parse(state).url).toBe("http://localhost:3000/slow");
});

it("a tab the desktop stopped reloading after crashes refuses agent work until a navigation revives it", async () => {
  const { f, sessionId } = await nativeSession();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/a" });
  f.sendEvent(sessionId, "ace.tabs.event", {
    tabId: "native-tab",
    method: "ace.rendererCrashed",
    params: { crashes: 3, reason: "crashed" },
  });
  await expect.poll(() => f.service.state("thread").tabs?.[0]?.lifecycle).toBe("crashed");
  await expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    "Browser tab crashed",
  );
  // Navigating asks the desktop for one more reload and waits for the restarted renderer.
  const reloaded = new Promise<void>((resolve) => f.requests.once("Page.reload", () => resolve()));
  const navigated = f.service.execute("thread", {
    action: "navigate",
    url: "http://localhost:3000/b",
  });
  await reloaded;
  f.sendEvent(sessionId, "ace.tabs.event", {
    tabId: "native-tab",
    method: "ace.rendererRestarted",
    params: {},
  });
  await navigated;
  expect(f.service.state("thread")).toMatchObject({ url: "http://localhost:3000/b" });
  expect(f.service.state("thread").tabs?.[0]?.lifecycle).toBe("live");
  await f.service.execute("thread", { action: "snapshot" });
});
