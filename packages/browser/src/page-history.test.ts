import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";
import { PageHistory } from "./page-history.ts";

/** A page whose engine answers `Page.getNavigationHistory` with `history.now`. */
function page(urls: string[], index = urls.length - 1) {
  const events = new EventEmitter();
  const history: { now: unknown; fail: boolean } = {
    now: { currentIndex: index, entries: urls.map((url, id) => ({ id, url })) },
    fail: false,
  };
  const cdp: BrowserCdp = {
    async send(method) {
      if (method !== "Page.getNavigationHistory") return {};
      if (history.fail) throw new Error("The page is gone");
      return history.now;
    },
    on: (method, listener) => events.on(method, listener),
    off: (method, listener) => events.off(method, listener),
  };
  const commit = (next: string[], at = next.length - 1) => {
    history.now = { currentIndex: at, entries: next.map((url, id) => ({ id, url })) };
  };
  return { cdp, history, commit, emit: (method: string) => events.emit(method, {}) };
}

/** A clock whose timers run only when the test says so. */
function manualClock() {
  const timers = new Set<() => void>();
  const clock: NavigationClock = {
    now: () => 0,
    set(_ms, run) {
      timers.add(run);
      return () => timers.delete(run);
    },
  };
  return { clock, fire: () => [...timers].forEach((run) => run()) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an in-page navigation (pushState) turns Back on", async () => {
  const p = page(["https://app.test/"]);
  const changes: string[] = [];
  const history = new PageHistory(() => changes.push("changed"), manualClock().clock);
  history.watch(p.cdp);
  await settle();
  expect(history.canGoBack).toBe(false);
  p.commit(["https://app.test/", "https://app.test/watch?v=1"]);
  p.emit("Page.navigatedWithinDocument");
  await settle();
  expect(history.canGoBack).toBe(true);
  expect(history.canGoForward).toBe(false);
  expect(changes.length).toBeGreaterThan(0);
});

test("an entry the engine adds only after reporting the navigation is still picked up", async () => {
  const p = page(["https://app.test/"]);
  const time = manualClock();
  const history = new PageHistory(() => {}, time.clock);
  history.watch(p.cdp);
  await settle();
  // The navigation is reported while the history still lacks its entry.
  p.emit("Page.navigatedWithinDocument");
  await settle();
  expect(history.canGoBack).toBe(false);
  p.commit(["https://app.test/", "https://app.test/next"]);
  time.fire();
  await settle();
  expect(history.canGoBack).toBe(true);
});

test("a new tab can't go back to the blank page it opened on", async () => {
  const p = page(["about:blank", "https://example.test/"]);
  const history = new PageHistory(() => {}, manualClock().clock);
  history.watch(p.cdp);
  await settle();
  expect(history.canGoBack).toBe(false);
  p.commit(["about:blank", "https://example.test/", "https://example.test/next"]);
  p.emit("Page.frameNavigated");
  await settle();
  expect(history.canGoBack).toBe(true);
});

test("going back turns Forward on, and leaving forward entries behind turns it off", async () => {
  const p = page(["https://a.test/", "https://b.test/"]);
  const history = new PageHistory(() => {}, manualClock().clock);
  history.watch(p.cdp);
  await settle();
  p.commit(["https://a.test/", "https://b.test/"], 0);
  p.emit("Page.frameNavigated");
  await settle();
  expect([history.canGoBack, history.canGoForward]).toEqual([false, true]);
  p.commit(["https://a.test/", "https://c.test/"]);
  p.emit("Page.frameNavigated");
  await settle();
  expect([history.canGoBack, history.canGoForward]).toEqual([true, false]);
});

test("a read that fails keeps the last answer, and the next navigation reads again", async () => {
  const p = page(["https://a.test/", "https://b.test/"]);
  const history = new PageHistory(() => {}, manualClock().clock);
  history.watch(p.cdp);
  await settle();
  p.history.fail = true;
  p.emit("Page.frameNavigated");
  await settle();
  expect(history.canGoBack).toBe(true);
  p.history.fail = false;
  p.commit(["https://a.test/", "https://b.test/"], 0);
  p.emit("Page.frameNavigated");
  await settle();
  expect([history.canGoBack, history.canGoForward]).toEqual([false, true]);
});

test("a history the engine answers in an unknown shape leaves Back and Forward unknown", async () => {
  const p = page([]);
  p.history.now = { pending_dialog: { dialogId: "d" } };
  const history = new PageHistory(() => {}, manualClock().clock);
  history.watch(p.cdp);
  await settle();
  expect(history.canGoBack).toBeUndefined();
});
