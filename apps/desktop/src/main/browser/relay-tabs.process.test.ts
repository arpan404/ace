import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BrowserService, type Actor, type BrowserBackend } from "@ace/browser";
import { groupViews } from "./test-support.ts";
import { connectDesktop, eventually, relayDaemon } from "./relay-test-support.ts";

/**
 * The daemon's multi-tab runtime (`BrowserService`, ADR 0083) driving the desktop's page group
 * (ADR 0085) through the real relay over a real local socket: the tab contract both sides keep.
 */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const noChrome: BrowserBackend = {
  kind: "headless",
  open: () => Promise.reject(new Error("ace's Chrome is not part of this test")),
};

async function nativeTabs() {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-relay-tabs-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const service = new BrowserService({
    dataDir,
    headlessBackend: noChrome,
    backendPreference: () => "embedded",
    tabLifecycle: false,
    ffmpeg: "",
  });
  cleanups.push(() => service.close());
  const daemon = await relayDaemon(cleanups, {
    register: (_id, transport) => service.registerEmbedded(transport),
  });
  const views = groupViews();
  await connectDesktop(cleanups, daemon, views.host);
  await service.open({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" });
  return { service, views };
}

const first: Actor = { kind: "agent", agentId: "agent-a" };
const second: Actor = { kind: "agent", agentId: "agent-b" };

it("two agents drive two native tabs at once; a slow tab holds up neither the other nor the view", async () => {
  const { service, views } = await nativeTabs();
  const own = await service.claimTab("t-1", first);
  await service.execute("t-1", { action: "tabs", operation: "open", label: "b" }, second);
  const other = service.currentTab("t-1", second).tabId;
  expect([own.tabId, other]).toEqual(["native-tab-1", "native-tab-2"]);
  // Nobody picked a tab, so the agent's new tab took the view; agent A keeps working unseen.
  expect(service.state("t-1").activeTabId).toBe(other);

  const release = views.tab(own.tabId).hold("Page.navigate");
  let slowDone = false;
  const slow = service
    .execute("t-1", { action: "navigate", url: "http://localhost:5173/a" }, first)
    .finally(() => (slowDone = true));
  await eventually(() =>
    expect(views.tab(own.tabId).calls.map((call) => call.method)).toContain("Page.navigate"),
  );
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/b" }, second);
  expect(views.tab(other).url()).toBe("http://localhost:5173/b");
  expect(slowDone).toBe(false);
  release();
  await slow;
  expect(views.tab(own.tabId).url()).toBe("http://localhost:5173/a");

  // Keys: the shown tab takes the desktop's native presses, an unseen one CDP key events.
  await service.execute("t-1", { action: "press", key: "Enter" }, second);
  await service.execute("t-1", { action: "press", key: "Enter" }, first);
  expect(views.tab(other).calls.map((call) => call.method)).toContain("press");
  const background = views.tab(own.tabId).calls.map((call) => call.method);
  expect(background).toContain("Input.dispatchKeyEvent");
  expect(background).not.toContain("press");
  expect(service.state("t-1").activeTabId).toBe(other);
});

it("the shown view learns whether an agent uses it, as the person moves between tabs", async () => {
  const { service, views } = await nativeTabs();
  const own = await service.claimTab("t-1", first);
  await service.execute("t-1", { action: "tabs", operation: "open", label: "b" }, second);
  const other = service.currentTab("t-1", second).tabId;
  const person = { kind: "human" as const, connectionId: "connection-1" };
  await service.execute("t-1", { action: "tabs", operation: "select", tabId: other }, person);
  // Nobody works in the shown tab yet: the person's file choosers stay native.
  await eventually(() => expect(views.tab(other).agent).toBe(false));
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/b" }, second);
  await eventually(() => expect(views.tab(other).agent).toBe(true));
  // The person can still use the agent's tab at once, and the agent its own tab meanwhile.
  await service.input("t-1", { kind: "key", event: "char", key: "x" }, "connection-1", other);
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/a" }, first);
  expect(views.tab(own.tabId).url()).toBe("http://localhost:5173/a");
});

/** `Page.getNavigationHistory` with the page on the last of `urls`. */
const history = (urls: string[]) => ({
  currentIndex: urls.length - 1,
  entries: urls.map((url, id) => ({ id, url })),
});

it("a native tab's in-page navigation turns Back on in the daemon's tab state; its blank start page doesn't", async () => {
  const { service, views } = await nativeTabs();
  const tabId = service.state("t-1").activeTabId ?? "";
  const page = views.tab(tabId);
  const shown = () => service.state("t-1").tabs?.find((tab) => tab.tabId === tabId);
  // The desktop opens each view on a blank page before its first address.
  page.results.set("Page.getNavigationHistory", history(["about:blank", "http://localhost:5173/"]));
  page.emit("Page.frameNavigated", { frame: { id: "main", url: "http://localhost:5173/" } });
  await eventually(() => expect(shown()).toMatchObject({ canGoBack: false, canGoForward: false }));
  // A single-page app pushes an entry of its own: no new document.
  page.results.set(
    "Page.getNavigationHistory",
    history(["about:blank", "http://localhost:5173/", "http://localhost:5173/watch"]),
  );
  page.emit("Page.navigatedWithinDocument", {
    frameId: "main",
    url: "http://localhost:5173/watch",
  });
  await eventually(() => expect(shown()).toMatchObject({ canGoBack: true, canGoForward: false }));
});
