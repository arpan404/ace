import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  BrowserService,
  type Actor,
  type BrowserBackend,
  type BrowserTabRecord,
  type BrowserTabStore,
} from "@ace/browser";
import { groupViews } from "./test-support.ts";
import { connectDesktop, eventually, relayDaemon } from "./relay-test-support.ts";

/**
 * The desktop's native tabs come back with the ids, addresses, labels and order they had
 * (#946): after the app and the daemon restart, and when the desktop returns without the views
 * it kept. The daemon's tab runtime drives the desktop's page groups through the real relay.
 */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const noChrome: BrowserBackend = {
  kind: "headless",
  open: () => Promise.reject(new Error("ace's Chrome is not part of this test")),
};
const worker: Actor = { kind: "agent", agentId: "worker" };

/** The daemon's database, as far as tabs go. */
function memoryTabs(): BrowserTabStore {
  const threads = new Map<string, BrowserTabRecord[]>();
  return {
    load: (threadId) => [...(threads.get(threadId) ?? [])],
    save: (threadId, tabs) => void threads.set(threadId, [...tabs]),
    clear: (threadId) => void threads.delete(threadId),
  };
}

async function daemon(tabStore: BrowserTabStore) {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-relay-restore-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const service = new BrowserService({
    dataDir,
    headlessBackend: noChrome,
    backendPreference: () => "embedded",
    tabLifecycle: false,
    tabStore,
    desktopReadoptionGraceMs: 0,
    ffmpeg: "",
  });
  const relay = await relayDaemon(cleanups, {
    register: (_id, transport) => service.registerEmbedded(transport),
  });
  return { service, relay };
}
const open = (service: BrowserService) =>
  service.open({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" });
const shape = (service: BrowserService) =>
  service.state("t-1").tabs?.map((tab) => ({ tabId: tab.tabId, url: tab.url, label: tab.label }));

/** Three labelled tabs at three addresses in the thread's native browser. */
async function threeTabs(service: BrowserService) {
  await open(service);
  await service.execute("t-1", { action: "navigate", url: "http://localhost:5173/a" }, worker);
  for (const name of ["b", "c"])
    await service.execute(
      "t-1",
      { action: "tabs", operation: "open", url: `http://localhost:5173/${name}`, label: name },
      worker,
    );
  return shape(service);
}

it("after the app and the daemon restart, the desktop reopens every tab with its id, address and label", async () => {
  const tabs = memoryTabs();
  const before = await daemon(tabs);
  const first = await connectDesktop(cleanups, before.relay, groupViews().host);
  const had = await threeTabs(before.service);
  expect(had).toHaveLength(3);
  await first.connection.close();
  await before.service.close();

  const after = await daemon(tabs);
  cleanups.push(() => after.service.close());
  const views = groupViews();
  await connectDesktop(cleanups, after.relay, views.host);
  await open(after.service);
  expect(shape(after.service)).toEqual(had);
  for (const tab of had ?? []) expect(views.tab(tab.tabId).url()).toBe(tab.url);
});

it("a desktop that comes back without its views brings back every tab, not one page", async () => {
  const { service, relay } = await daemon(memoryTabs());
  cleanups.push(() => service.close());
  const first = await connectDesktop(cleanups, relay, groupViews().host);
  const had = await threeTabs(service);
  // The app quits (its views close) and starts again: nothing is left to adopt.
  await first.connection.close();
  await eventually(() => expect(service.state("t-1").pageStateLost).toBe(true));
  const views = groupViews();
  await connectDesktop(cleanups, relay, views.host);
  await open(service);
  await eventually(() => expect(shape(service)).toEqual(had));
  for (const tab of had ?? []) expect(views.tab(tab.tabId).url()).toBe(tab.url);
});
