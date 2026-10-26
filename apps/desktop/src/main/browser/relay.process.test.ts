import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddedBackend } from "@ace/browser";
import { BrowserOpen } from "@ace/protocol";
import { fakeViews, screencastFrame } from "./test-support.ts";
import { connectDesktop, eventually, relayDaemon, type RelayClock } from "./relay-test-support.ts";

/**
 * The desktop backend against the daemon's own relay, `EmbeddedBackend` from `@ace/browser`,
 * over a real local socket (see `relay-test-support.ts`).
 */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * The relay's own deadlines, a thousand times shorter: a 30 s command deadline passes in 30 ms
 * and the 5 s liveness ping in 5 ms.
 */
const fastClock: RelayClock = {
  now: () => performance.now(),
  set(delayMs: number, work: () => void) {
    const timer = setTimeout(work, delayMs / 1000);
    return () => clearTimeout(timer);
  },
};

async function setup(clock?: RelayClock) {
  const daemon = await relayDaemon(cleanups, { clock });
  const views = fakeViews();
  const { home, connection } = await connectDesktop(cleanups, daemon, views.host);
  const relay = daemon.relays.at(-1);
  if (!relay) throw new Error("not registered");
  const lost: string[] = [];
  /** The tabs the person used directly, as the daemon heard (`ace.humanInput`). */
  const human: string[] = [];
  const open = (into: EmbeddedBackend) => {
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    return into.open({
      options: BrowserOpen.parse({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" }),
      profileDir: home,
      signal: abort.signal,
      allowed: async () => true,
      navigation: () => {},
      log: () => {},
      lost: (reason: string) => lost.push(reason),
      humanInput: (tabId?: string) => human.push(tabId ?? "page"),
    });
  };
  const session = await open(relay);
  return { daemon, views, connection, relay, session, lost, human, open, page: views.only() };
}

describe("embedded backend against the daemon relay", () => {
  const start = setup;

  it("registers with the daemon's desktop credential and opens a view the relay drives over CDP", async () => {
    const { session, page } = await start();
    // The relay's origin guard reached the view: Fetch interception is on before any page.
    expect(page.calls.map((call) => call.method)).toContain("Fetch.enable");
    expect(await session.cdp.send("Page.captureScreenshot", { format: "png" })).toEqual({
      data: "AA==",
    });
    await session.navigate("http://localhost:5173/", 5_000);
    expect(session.url()).toBe("http://localhost:5173/");
  });

  it("keeps the person's input on while the daemon says an agent uses the view", async () => {
    const { session, page } = await start();
    expect(page.nativeInput).toBe(true);
    await session.agentUse?.("page", true);
    expect(page.agentControl).toBe(true);
    expect(page.nativeInput).toBe(true);
    await session.agentUse?.("page", false);
    expect(page.agentControl).toBe(false);
  });

  it("tells the daemon when the person clicks a view an agent is using", async () => {
    const { session, page, human } = await start();
    await session.agentUse?.("page", true);
    page.personClicks();
    await eventually(() => expect(human).toEqual(["page"]));
  });

  it("delivers the first and then only the newest screencast frame as the relay acknowledges", async () => {
    const { session, page } = await start();
    const received: string[] = [];
    session.cdp.on("Page.screencastFrame", (params) => {
      if (typeof params === "object" && params !== null && "data" in params)
        received.push(String(params.data));
    });
    for (const [frameId, data] of [
      [1, "f1"],
      [2, "f2"],
      [3, "f3"],
      [4, "f4"],
    ] as const)
      page.emit("Page.screencastFrame", screencastFrame(frameId, data));
    await eventually(() => expect(received).toEqual(["f1", "f4"]));
    expect(page.acks()).toBe(4);
  });

  it("Quit tells the daemon its sessions are gone and closes the views", async () => {
    const { connection, lost, page } = await start();
    connection.close();
    await eventually(() => expect(lost).toHaveLength(1));
    expect(page.closed).toBe(true);
    expect(connection.state()).toBe("off");
  });

  it("a backend reconnect re-adopts views without navigating", async () => {
    const { daemon, connection, session, open, page, views } = await start();
    await session.navigate("http://localhost:5173/app", 5_000);
    const navigations = () => page.calls.filter((call) => call.method === "Page.navigate").length;
    expect(navigations()).toBe(1);
    daemon.drop();
    await eventually(() => expect(daemon.relays).toHaveLength(2));
    await eventually(() => expect(connection.state()).toBe("registered"));
    expect(page).toMatchObject({ closed: false, orphaned: true });
    const relay = daemon.relays[1];
    if (!relay) throw new Error("not registered again");
    // What the daemon's recovery does: open the thread again, then go back to its last URL.
    const adopted = await open(relay);
    await adopted.navigate("http://localhost:5173/app", 5_000);
    expect(views.opened).toHaveLength(1);
    expect(page).toMatchObject({ closed: false, orphaned: false, adoptions: 1 });
    expect(navigations()).toBe(1);
    expect(adopted.url()).toBe("http://localhost:5173/app");
    expect(await adopted.cdp.send("Page.captureScreenshot", { format: "png" })).toEqual({
      data: "AA==",
    });
  });

  it("a view that dies on its own is reported lost to the daemon", async () => {
    const { lost, page } = await start();
    page.emit("Inspector.detached", { reason: "Render process gone" });
    await eventually(() => expect(lost).toEqual(["Desktop browser view closed"]));
  });
});

it("a slow command fails alone without losing the page", async () => {
  const { session, page, lost } = await setup(fastClock);
  page.hung.add("Runtime.evaluate");
  await expect(
    session.cdp.send("Runtime.evaluate", { expression: "while(true){}" }),
  ).rejects.toThrow("Desktop browser command timed out");
  // The desktop answered the liveness ping: the page and the session stay.
  await eventually(() =>
    expect(page.calls.filter((call) => call.method === "ace.ping")).toHaveLength(1),
  );
  expect(await session.cdp.send("Page.captureScreenshot", { format: "png" })).toEqual({
    data: "AA==",
  });
  expect(lost).toEqual([]);
  expect(page.closed).toBe(false);
});

it("a command times out and the view misses its liveness ping too: only then is the page lost", async () => {
  const { session, page, lost } = await setup(fastClock);
  page.hung.add("*");
  await expect(session.cdp.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(
    "Desktop browser command timed out",
  );
  await eventually(() => expect(lost).toEqual(["Desktop browser command timed out"]));
});

it("large trace batches cross the real desktop socket without losing target frame events", async () => {
  const { session, page, lost } = await setup();
  const events = Array.from({ length: 30 }, (_, index) => ({
    name: "DrawFrame",
    ts: index,
    payload: "x".repeat(70_000),
  }));
  const received: unknown[] = [];
  const arrived = Promise.withResolvers<void>();
  session.cdp.on("Tracing.dataCollected", (raw) => {
    const batch = z.object({ value: z.array(z.unknown()) }).parse(raw);
    received.push(...batch.value);
    if (received.length === events.length) arrived.resolve();
  });
  page.emit("Tracing.dataCollected", { value: events });
  await arrived.promise;
  expect(received).toEqual(events);
  expect(lost).toEqual([]);
  expect(await session.cdp.send("Page.captureScreenshot", { format: "png" })).toEqual({
    data: "AA==",
  });
});

it.runIf(process.platform === "win32")(
  "Windows: a slow command fails alone without losing the page",
  async () => {
    // Windows timers fire at about 15.6 ms granularity, so deadlines shrink 50 times, not 1000.
    const windowsFastClock: RelayClock = {
      now: () => performance.now(),
      set(delayMs: number, work: () => void) {
        const timer = setTimeout(work, delayMs / 50);
        return () => clearTimeout(timer);
      },
    };
    const { session, page, lost } = await setup(windowsFastClock);
    page.hung.add("Runtime.evaluate");
    await expect(
      session.cdp.send("Runtime.evaluate", { expression: "while(true){}" }),
    ).rejects.toThrow("Desktop browser command timed out");
    await eventually(() =>
      expect(page.calls.filter((call) => call.method === "ace.ping")).toHaveLength(1),
    );
    expect(await session.cdp.send("Page.captureScreenshot", { format: "png" })).toEqual({
      data: "AA==",
    });
    expect(lost).toEqual([]);
    expect(page.closed).toBe(false);
  },
);
