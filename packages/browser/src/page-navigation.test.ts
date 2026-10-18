import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";
import { traverseHistory } from "./page-navigation.ts";

/** A page with two history entries whose engine answers a move with `answer`'s event. */
function page(answer: string | undefined) {
  const events = new EventEmitter();
  const sent: string[] = [];
  const cdp: BrowserCdp = {
    async send(method) {
      sent.push(method);
      if (method === "Page.getNavigationHistory")
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: "http://localhost/form" },
            { id: 2, url: "http://localhost/next" },
          ],
        };
      if (answer) queueMicrotask(() => events.emit(answer, {}));
      return {};
    },
    on: (method, listener) => events.on(method, listener),
    off: (method, listener) => events.off(method, listener),
  };
  return { cdp, sent };
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

test("going back from a page the person edited fails at once when the page stays", async () => {
  const { cdp } = page("ace.unloadRefused");
  await expect(traverseHistory(cdp, "back", () => {}, manualClock().clock)).rejects.toMatchObject({
    code: "unsaved_changes",
  });
});

test("a reload that the page lets go of succeeds as soon as loading starts", async () => {
  const { cdp, sent } = page("Page.frameStartedLoading");
  await expect(traverseHistory(cdp, "reload", () => {}, manualClock().clock)).resolves.toEqual({
    ok: true,
  });
  expect(sent).toContain("Page.reload");
});

test("an engine that reports nothing is taken to have moved once the verdict window ends", async () => {
  const { cdp } = page(undefined);
  const time = manualClock();
  const moved = traverseHistory(cdp, "back", () => {}, time.clock);
  await new Promise((resolve) => setImmediate(resolve));
  time.fire();
  await expect(moved).resolves.toEqual({ ok: true });
});

test("going forward with no later entry does nothing and succeeds", async () => {
  const { cdp, sent } = page("ace.unloadRefused");
  await expect(traverseHistory(cdp, "forward", () => {}, manualClock().clock)).resolves.toEqual({
    ok: true,
  });
  expect(sent).not.toContain("Page.navigateToHistoryEntry");
});
