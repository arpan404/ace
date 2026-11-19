import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, type BrowserTabRecord } from "@ace/browser";
import { ThreadId, type BrowserState } from "@ace/protocol";
import { botBrowsers } from "./spade-computers.ts";

/** One of ace's browser backends holding one thread's tabs, and telling its observers. */
function backend(threadId: ThreadId, tabs: { tabId: string; title: string; url: string }[]) {
  const observers = new Set<(state: BrowserState) => void>();
  const state = (): BrowserState => ({ threadId, url: "", closed: false, tabs });
  return {
    hasActiveSession: (id: string) => id === threadId,
    state,
    savedTabs: () => [],
    observeStates(observer: (state: BrowserState) => void) {
      observers.add(observer);
      return () => void observers.delete(observer);
    },
    changed: () => observers.forEach((observer) => observer(state())),
  };
}

test("a bot's tabs in the person's own Chrome are listed beside ace's, marked as theirs", () => {
  const threadId = ThreadId.parse("bot-thread");
  const ace = backend(threadId, [{ tabId: "t1", title: "Fares", url: "https://fly.test/" }]);
  const user = backend(threadId, [{ tabId: "t1", title: "Bank", url: "https://bank.test/" }]);
  const browsers = botBrowsers({ ace: () => ace, user: () => user });
  expect(browsers.tabs(threadId)).toEqual([
    { tabId: "t1", title: "Fares", url: "https://fly.test/" },
    { tabId: "t1", title: "Bank", url: "https://bank.test/", backend: "user" },
  ]);
  expect(browsers.tabs(ThreadId.parse("other"))).toEqual([]);
});

test("a change in the person's own Chrome is heard like one in ace's browser", () => {
  const threadId = ThreadId.parse("bot-thread");
  const ace = backend(threadId, []);
  const user = backend(threadId, []);
  const heard: string[] = [];
  const stop = botBrowsers({ ace: () => ace, user: () => user }).watch((state) =>
    heard.push(state.threadId),
  );
  user.changed();
  ace.changed();
  stop();
  user.changed();
  expect(heard).toEqual([threadId, threadId]);
});

test("a browser not loaded since a restart lists the tabs kept for it, and an unreadable store is unknown", async () => {
  const threadId = ThreadId.parse("bot-thread");
  const kept: BrowserTabRecord[] = [
    { tabId: "t2", position: 1, url: "https://fly.test/book", title: "Booking", lastActiveAt: 2 },
    { tabId: "t1", position: 0, url: "https://fly.test/", title: "Fares", lastActiveAt: 1 },
  ];
  let readable = true;
  const browser = new BrowserService({
    dataDir: await mkdtemp(join(tmpdir(), "spade-computers-")),
    tabStore: {
      load: (id) => {
        if (!readable) throw new Error("disk");
        return id === threadId ? kept : [];
      },
      save: () => {},
      clear: () => {},
    },
  });
  try {
    const browsers = botBrowsers({ ace: () => browser, user: () => undefined });
    expect(browser.hasActiveSession(threadId)).toBe(false);
    expect(browsers.tabs(threadId)).toEqual([
      { tabId: "t1", title: "Fares", url: "https://fly.test/" },
      { tabId: "t2", title: "Booking", url: "https://fly.test/book" },
    ]);
    expect(browsers.tabs(ThreadId.parse("never-opened"))).toEqual([]);
    readable = false;
    expect(browsers.tabs(threadId)).toBeUndefined();
  } finally {
    await browser.close();
  }
});
