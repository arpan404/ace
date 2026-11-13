import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { ace, disk } from "./computers-test-support.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("taking over stops the bot's call in flight and is answered only once it has ended", async () => {
  const daemon = ace();
  const running = daemon.call("browser_act", { actingFor: "fares" });
  await settle();
  expect(daemon.acting.aborted).toBe(false);
  const taken = daemon.computers.drive("fares", "person");
  let answered = false;
  void taken.then(() => (answered = true));
  await settle();
  // Stopped at once, but the backend has not ended yet: no answer until it has.
  expect(daemon.acting.aborted).toBe(true);
  expect(daemon.acting.ended).toBe(false);
  expect(answered).toBe(false);
  expect(await taken).toEqual({ driver: "person" });
  expect(daemon.acting.ended).toBe(true);
  expect(await running).toEqual({ error: "cancelled" });
});

test("a call the bot starts after handing back runs, unaffected by the earlier take-over", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  await daemon.computers.drive("fares", "person");
  await daemon.computers.drive("fares", "bot");
  const running = daemon.call("browser_act", { actingFor: "fares" });
  await settle();
  daemon.acting.release();
  expect((await running).ran).toBe(daemon.threadOf("fares"));
  expect(daemon.acting.aborted).toBe(false);
});

test("a take-over whose call never stops is answered once the drain limit passes", async () => {
  const daemon = ace();
  daemon.acting.stubborn = true;
  void daemon.call("browser_act", { actingFor: "fares" });
  await settle();
  let answered = false;
  const taken = daemon.computers.drive("fares", "person").then((result) => {
    answered = true;
    return result;
  });
  await settle();
  expect(daemon.acting.aborted).toBe(true);
  expect(answered).toBe(false);
  for (const run of daemon.timers.splice(0)) run();
  expect(await taken).toEqual({ driver: "person" });
  // Its refusals hold meanwhile.
  expect(await daemon.call("browser_tabs", { actingFor: "fares" })).toEqual({
    error: "person_driving",
  });
});

test("the person still drives after a daemon restart, and Spade sending driver=person again keeps the hand-back", async () => {
  const saved = disk();
  const before = ace(saved);
  const threadId = ThreadId.parse((await before.call("browser_tabs", { actingFor: "fares" })).ran);
  const home = { tabId: "t1", title: "Fares", url: "https://fly.test/" };
  before.tabs.set(threadId, [home]);
  await before.computers.drive("fares", "person");
  const login = { ...home, title: "Sign in", url: "https://fly.test/login" };
  before.tabs.set(threadId, [login]);
  before.computers.browserChanged({ threadId });

  const after = ace(saved);
  after.tabs.set(threadId, [login]);
  expect(after.computers.computer("fares").driver).toBe("person");
  expect(await after.call("browser_tabs", { actingFor: "fares" })).toEqual({
    error: "person_driving",
  });
  // Spade re-sends the take-over on reconnect: nothing restarts.
  expect(await after.computers.drive("fares", "person")).toEqual({ driver: "person" });
  expect((await after.computers.drive("fares", "bot")).handback).toMatchObject({
    visited: ["https://fly.test/login"],
    drivenMs: 0,
  });
  expect(ace(saved).computers.computer("fares").driver).toBe("bot");
});

test("handing back reports where the person went, the tabs they opened and closed, and the screen", async () => {
  const daemon = ace();
  const threadId = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "fares" })).ran);
  const home = { tabId: "t1", title: "Fares", url: "https://fly.test/" };
  const old = { tabId: "t2", title: "Old", url: "https://old.test/" };
  daemon.tabs.set(threadId, [home, old]);
  expect(await daemon.computers.drive("fares", "person")).toEqual({ driver: "person" });
  expect(daemon.computers.computer("fares").driver).toBe("person");
  const login = { ...home, title: "Sign in", url: "https://fly.test/login" };
  daemon.tabs.set(threadId, [login]);
  daemon.computers.browserChanged({ threadId });
  const booking = { tabId: "t3", title: "Booking", url: "https://fly.test/book" };
  // A tab in the person's own Chrome with the same id is a different tab.
  const bank = { tabId: "t2", title: "Bank", url: "https://bank.test/", backend: "user" as const };
  daemon.tabs.set(threadId, [login, booking, bank]);
  daemon.computers.browserChanged({ threadId });
  daemon.computers.screenUsedBy(threadId);
  daemon.advance(180_000);
  expect(await daemon.computers.drive("fares", "bot")).toEqual({
    driver: "bot",
    handback: {
      drivenMs: 180_000,
      visited: ["https://fly.test/login", "https://fly.test/book", "https://bank.test/"],
      opened: [booking, bank],
      closed: [old],
      screenUsed: true,
    },
  });
  // Handing back twice reports nothing new.
  expect(await daemon.computers.drive("fares", "bot")).toEqual({ driver: "bot" });
});

test("another bot's browser changing never lands in a driven bot's hand-back", async () => {
  const daemon = ace();
  await daemon.call("browser_tabs", { actingFor: "fares" });
  const news = ThreadId.parse((await daemon.call("browser_tabs", { actingFor: "news" })).ran);
  await daemon.computers.drive("fares", "person");
  daemon.tabs.set(news, [{ tabId: "n1", title: "News", url: "https://news.test/" }]);
  daemon.computers.browserChanged({ threadId: news });
  daemon.computers.screenUsedBy(news);
  expect((await daemon.computers.drive("fares", "bot")).handback).toMatchObject({
    visited: [],
    screenUsed: false,
  });
});
