import { expect, test } from "vitest";
import { ThreadId, type BrowserState } from "@ace/protocol";
import { botBrowsers } from "./spade-computers.ts";

/** One of ace's browser backends holding one thread's tabs, and telling its observers. */
function backend(threadId: ThreadId, tabs: { tabId: string; title: string; url: string }[]) {
  const observers = new Set<(state: BrowserState) => void>();
  const state = (): BrowserState => ({ threadId, url: "", closed: false, tabs });
  return {
    hasActiveSession: (id: string) => id === threadId,
    state,
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
