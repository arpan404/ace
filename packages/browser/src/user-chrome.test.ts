import { expect, test } from "vitest";
import type { UserBrowserDaemonMessage } from "@ace/protocol";
import { UserChromeHub } from "./user-chrome-hub.ts";

/** A clock whose timers fire only when the test advances it. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ at: number; work: () => void }>();
  return {
    now: () => now,
    set(delay: number, work: () => void) {
      const timer = { at: now + delay, work };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          timer.work();
        }
    },
  };
}
const browser = (profileId: string) => ({
  family: "chrome" as const,
  version: "155",
  profileId,
  extensionVersion: "0.1.0",
});
function transport() {
  const sent: UserBrowserDaemonMessage[] = [];
  const closed: string[] = [];
  return {
    sent,
    closed,
    send: (message: UserBrowserDaemonMessage) => (sent.push(message), true),
    close: (reason: string) => closed.push(reason),
  };
}

test("a command the browser never answers fails at its deadline while later ones still settle", async () => {
  const clock = manualClock();
  const hub = new UserChromeHub({ now: () => 1, clock });
  const wire = transport();
  const link = hub.register(browser("p"), wire);
  const silent = link.command({ op: "tabs.list" });
  const answered = link.command({ op: "tabs.list" });
  const second = wire.sent[1];
  if (second?.type !== "user_browser.command") throw new Error("expected a command");
  link.handle({ type: "user_browser.reply", id: second.id, ok: true, result: [] });
  await expect(answered).resolves.toEqual([]);
  clock.advance(30_000);
  await expect(silent).rejects.toThrow(/did not answer/);
  expect(link.closed).toBe(false);
});

test("the same browser profile reconnecting replaces its old link and ends that link's tabs", async () => {
  const clock = manualClock();
  const hub = new UserChromeHub({ now: () => 1, clock });
  const first = transport();
  const old = hub.register(browser("same"), first);
  const tab = old.tab(4);
  const lost: string[] = [];
  tab.onDetached((reason) => lost.push(reason));
  const pending = old.command({ op: "tabs.list" });
  const replacement = hub.register(browser("same"), transport());
  await expect(pending).rejects.toThrow(/connected again/);
  expect(lost).toEqual(["disconnected"]);
  expect(first.closed).toEqual(["This browser profile connected again"]);
  expect(hub.connections().map((connection) => connection.connectionId)).toEqual([
    replacement.connectionId,
  ]);
  await expect(tab.send("Runtime.evaluate")).rejects.toThrow(/no longer shared/);
});

test("events reach only the tab they belong to, and a detach ends that tab alone", () => {
  const hub = new UserChromeHub({ now: () => 1, clock: manualClock() });
  const link = hub.register(browser("p"), transport());
  const one = link.tab(1);
  const two = link.tab(2);
  const seen: string[] = [];
  one.on("Page.loadEventFired", () => seen.push("one"));
  two.on("Page.loadEventFired", () => seen.push("two"));
  const lost: string[] = [];
  one.onDetached((reason) => lost.push(`one:${reason}`));
  two.onDetached((reason) => lost.push(`two:${reason}`));
  link.handle({
    type: "user_browser.event",
    event: { kind: "cdp", tabId: 2, method: "Page.loadEventFired", params: {} },
  });
  link.handle({
    type: "user_browser.event",
    event: { kind: "detached", tabId: 1, reason: "closed" },
  });
  expect(seen).toEqual(["two"]);
  expect(lost).toEqual(["one:closed"]);
});
