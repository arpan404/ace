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

it("a person holding the shown tab stops agents there only; the lease follows the view", async () => {
  const { service, views } = await nativeTabs();
  const own = await service.claimTab("t-1", first);
  await service.execute("t-1", { action: "tabs", operation: "open", label: "b" }, second);
  const other = service.currentTab("t-1", second).tabId;
  service.takeover("t-1", "connection-1", "shared", other);
  await eventually(() => expect(views.tab(other).agent).toBe(false));
  expect(views.tab(own.tabId).agent).toBe(true);
  await expect(
    service.execute("t-1", { action: "navigate", url: "http://localhost:5173/b" }, second),
  ).rejects.toThrow();
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/a" }, first);
  expect(views.tab(own.tabId).url()).toBe("http://localhost:5173/a");
  // The person shows the agent's tab: the desktop now applies that tab's (agent) lease.
  await service.execute(
    "t-1",
    { action: "tabs", operation: "select", tabId: own.tabId },
    { kind: "human", connectionId: "connection-1" },
  );
  await eventually(() => {
    expect(service.state("t-1").activeTabId).toBe(own.tabId);
    expect(views.tab(own.tabId).agent).toBe(true);
  });
  // Handing back the person's tab leaves both tabs to the agents again.
  service.handback("t-1", "connection-1", other);
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/c" }, second);
  expect(views.tab(other).url()).toBe("http://localhost:5173/c");
});
