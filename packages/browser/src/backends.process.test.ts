import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { backendFixture } from "./backend-test-support.ts";
import {
  BrowserOpen,
  type BrowserState,
  type BrowserBackendLost,
  BrowserBackendRequest,
} from "@ace/protocol";
import { keepAgentsOut } from "./collaboration-test-support.ts";

const snapshot = z.object({ nodes: z.array(z.object({ ref: z.string() })) });
it("prefers the socket desktop while a per-thread override routes another thread headlessly", async () => {
  const f = await backendFixture({
    backendPreference: (options) => (options.threadId === "headless" ? "headless" : "auto"),
  });
  expect(await f.open()).toMatchObject({ backend: "embedded" });
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/desktop" });
  expect([...f.pages.values()].map((page) => page.url)).toEqual(["http://localhost:3000/desktop"]);
  expect(await f.open("headless")).toMatchObject({ backend: "headless" });
  await f.service.execute("headless", {
    action: "navigate",
    url: "http://localhost:3000/headless",
  });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://localhost:3000/headless"]);
  expect(f.headless.opens[0]?.profileDir).toContain(f.home);
});
it("selects headless after desktop disconnect and rejects an explicit missing embedded backend", async () => {
  const f = await backendFixture({
    backendPreference: (options) => (options.threadId === "explicit" ? "embedded" : "auto"),
  });
  await f.disconnect();
  expect(await f.open()).toMatchObject({ backend: "headless" });
  await expect(f.open("explicit")).rejects.toThrow("unavailable");
});
it("a desktop that opens a view but never draws it hands the session to ace's Chromium", async () => {
  const errors: unknown[] = [];
  const f = await backendFixture({
    firstPictureMs: 200,
    onError: (error) => errors.push(error),
  });
  // A locked or sleeping Mac: the view opens, but its first picture never comes.
  f.hold("Page.captureScreenshot");
  const desktopClosed = once(f.requests, "close");
  expect(await f.open()).toMatchObject({ backend: "headless", closed: false });
  await desktopClosed;
  expect(f.pages.size).toBe(0);
  expect(String(errors[0])).toContain("drew no picture");
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/after" });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://localhost:3000/after"]);
});
it("an explicit desktop preference never moves a slow first picture to another backend", async () => {
  const f = await backendFixture({ firstPictureMs: 50, backendPreference: () => "embedded" });
  f.hold("Page.captureScreenshot");
  const opened = f.open();
  const screenshot = (await once(f.requests, "Page.captureScreenshot"))[0];
  await new Promise((resolve) => setTimeout(resolve, 150));
  f.reply(BrowserBackendRequest.parse(screenshot), { data: "AA==" });
  expect(await opened).toMatchObject({ backend: "embedded", closed: false });
  expect(f.headless.opens).toHaveLength(0);
});
it("a desktop page moves to ace's Chromium when the desktop's screen locks and stays there after unlock", async () => {
  const f = await backendFixture();
  expect(await f.open()).toMatchObject({ backend: "embedded" });
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const moved = Promise.withResolvers<void>();
  const states: BrowserState[] = [];
  f.service.subscribe("thread", "viewer", {}, (state) => {
    states.push(state);
    if (state.backend === "headless" && state.status === "ready") moved.resolve();
  });
  const desktopClosed = once(f.requests, "close");
  f.service.desktopDrawable(false);
  await moved.promise;
  await desktopClosed;
  expect(f.pages.size).toBe(0);
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    url: "http://localhost:3000/page",
    closed: false,
  });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://localhost:3000/page"]);
  // The agent keeps working on the moved page.
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/next" });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://localhost:3000/next"]);
  // A new page while the screen is locked never asks the desktop.
  let desktopOpens = 0;
  f.requests.on("open", () => desktopOpens++);
  expect(await f.open("other")).toMatchObject({ backend: "headless" });
  expect(desktopOpens).toBe(0);
  // Unlocking moves nothing back mid-work.
  f.service.desktopDrawable(true);
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/after" });
  expect(f.service.state("thread")).toMatchObject({ backend: "headless", closed: false });
  expect(states.some((state) => state.closed)).toBe(false);
});
it("an explicit desktop page stays on the desktop when its screen locks", async () => {
  const f = await backendFixture({ backendPreference: () => "embedded" });
  expect(await f.open()).toMatchObject({ backend: "embedded" });
  f.service.desktopDrawable(false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  expect(f.service.state("thread")).toMatchObject({ backend: "embedded", closed: false });
  expect([...f.pages.values()].map((page) => page.url)).toEqual(["http://localhost:3000/page"]);
  expect(f.headless.opens).toHaveLength(0);
});
const quick = {
  quietMs: 400,
  maxWaitMs: 1_200,
  inUseMs: 1_000,
  followAfterMs: 1_000,
  presentMs: 1_000,
};
const key = (char: string) => ({ kind: "key", event: "char", key: char }) as const;
it("agent input waits while the person is active in the tab and proceeds once they pause", async () => {
  const f = await backendFixture({ collaboration: quick });
  await f.open();
  const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
    ?.ref;
  if (!ref) throw new Error("Missing ref");
  const page = [...f.pages.values()][0];
  await f.service.input("thread", key("x"), "person");
  const started = Date.now();
  const typing = f.service.execute("thread", { action: "type", ref, text: "agent" });
  // The person keeps typing; nothing of theirs waits for the agent.
  await f.service.input("thread", key("y"), "person");
  expect(page?.text).toBe("xy");
  await typing;
  expect(Date.now() - started).toBeGreaterThanOrEqual(quick.quietMs - 50);
  expect(page?.text).toBe("xyagent");
});
it("agent input gives up with human_active while the person never pauses", async () => {
  const f = await backendFixture({ collaboration: quick });
  await f.open();
  const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
    ?.ref;
  if (!ref) throw new Error("Missing ref");
  await f.service.input("thread", key("z"), "person");
  const typing = f.service.execute("thread", { action: "type", ref, text: "agent" });
  const rejected = expect(typing).rejects.toMatchObject({ code: "human_active" });
  const busy = { on: true };
  const person = (async () => {
    while (busy.on) {
      await f.service.input("thread", key("z"), "person");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  await rejected;
  busy.on = false;
  await person;
  expect([...f.pages.values()][0]?.text).not.toContain("agent");
});
it("agent reads never wait for the person", async () => {
  const f = await backendFixture({ collaboration: { ...quick, quietMs: 5_000 } });
  await f.open();
  await f.service.input("thread", key("x"), "person");
  const started = Date.now();
  await f.service.execute("thread", { action: "snapshot" });
  await f.service.screenshot("thread");
  expect(Date.now() - started).toBeLessThan(2_000);
});
it("the person's input is never refused or queued behind a busy agent command", async () => {
  const f = await backendFixture();
  await f.open();
  f.hold("Page.navigate");
  const navigating = f.service.execute("thread", {
    action: "navigate",
    url: "http://localhost:3000/slow",
  });
  const [held] = await once(f.requests, "Page.navigate");
  await f.service.input("thread", key("x"), "person");
  expect([...f.pages.values()][0]?.text).toBe("x");
  f.releaseHold();
  // Ends the held navigation (an aborted one would wait for the frame to stop loading).
  f.reply(BrowserBackendRequest.parse(held), { errorText: "net::ERR_CONNECTION_REFUSED" });
  await navigating.catch(() => {});
});
it("an agent working in a tab marks it in use and tells the backend", async () => {
  const f = await backendFixture({ collaboration: quick });
  await f.open();
  await f.service.execute(
    "thread",
    { action: "scroll", x: 0, y: 1 },
    { kind: "agent", agentId: "a" },
  );
  const page = [...f.pages.values()][0];
  expect(page?.agent).toBe(true);
  await expect.poll(() => page?.agent, { timeout: 3_000 }).toBe(false);
});
it("pause on desktop loss emits the URL and rejects an in-flight read without replay", async () => {
  const f = await backendFixture();
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const events: BrowserBackendLost[] = [];
  const states: BrowserState[] = [];
  f.service.subscribe(
    "thread",
    "viewer",
    {},
    (state) => states.push(state),
    (event) => {
      if (event.type === "browser.backend.lost") events.push(event);
    },
  );
  f.hold("Accessibility.getFullAXTree");
  const started = once(f.requests, "Accessibility.getFullAXTree");
  const failure = expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    "disconnected",
  );
  await started;
  await f.disconnect();
  await failure;
  expect(events).toEqual([
    expect.objectContaining({
      recovery: "pause",
      url: "http://localhost:3000/page",
      pageStateLost: true,
    }),
  ]);
  expect(states.at(-1)).toMatchObject({ status: "paused" });
  await expect(f.service.execute("thread", { action: "scroll", x: 0, y: 1 })).rejects.toMatchObject(
    { code: "browser_paused" },
  );
  expect(f.headless.pages).toHaveLength(0);
});
it("headless recovery invalidates old refs while reporting lost state", async () => {
  const f = await backendFixture({ backendLoss: () => "headless" });
  await f.service.open({ threadId: "thread", workspaceId: "workspace", profile: "persistent" });
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
    ?.ref;
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "human");
  const ready = Promise.withResolvers<void>();
  f.service.subscribe("thread", "viewer", {}, (state) => {
    if (state.backend === "headless" && state.status === "ready") ready.resolve();
  });
  await f.disconnect();
  await ready.promise;
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    url: "http://localhost:3000/page",
    pageStateLost: true,
  });
  expect(f.headless.opens[0]?.options.profile).toBe("ephemeral");
  expect(f.headless.pages[0]?.text).toBe("");
  await expect(
    f.service.execute(
      "thread",
      { action: "type", ref, text: "x" },
      { kind: "human", connectionId: "human" },
    ),
  ).rejects.toMatchObject({ code: "browser_restarted" });
});
it.each(["embedded", "headless"] as const)(
  "%s sessions let the agent script pages and keep refs, screenshot bytes and console logs",
  async (backend) => {
    const f = await backendFixture({ backendPreference: () => backend });
    await f.open();
    const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
      ?.ref;
    // No host hook: an agent's script runs with nobody asked.
    expect(await f.service.execute("thread", { action: "evaluate", expression: "1" })).toBe(1);
    if (backend === "embedded") {
      const sessionId = [...f.pages.keys()][0];
      if (!sessionId) throw new Error("Missing session");
      f.sendEvent(sessionId, "Runtime.consoleAPICalled", {
        type: "log",
        args: [{ value: "marker" }],
      });
    } else f.headless.opens[0]?.log({ kind: "console", type: "log", text: "marker" });
    // A subsequent round-trip fences the preceding event on the ordered socket.
    const image = z
      .object({ path: z.string() })
      .parse(await f.service.execute("thread", { action: "screenshot" }));
    expect(await readFile(image.path)).toEqual(Buffer.from([0]));
    const logs = z
      .object({ entries: z.array(z.object({ text: z.string() })) })
      .parse(await f.service.execute("thread", { action: "logs" }));
    expect(logs.entries.some((entry) => entry.text.includes("marker"))).toBe(true);
    await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000" });
    await expect(f.service.execute("thread", { action: "click", ref })).rejects.toThrow("ref");
  },
);
it("closes a pressured relay and pauses its session instead of queuing undelivered input", async () => {
  const f = await backendFixture();
  await f.open();
  const active = f.service.state("thread");
  f.pressure();
  // Whichever command meets the pressure first (the agent's mark or the snapshot) pauses it.
  await expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    /backpressure|paused/,
  );
  expect(f.service.state("thread")).toMatchObject({
    url: active.url,
    status: "paused",
    reason: "Desktop browser transport backpressure",
  });
  await expect(f.service.execute("thread", { action: "scroll", x: 0, y: 1 })).rejects.toMatchObject(
    { code: "browser_paused" },
  );
});
async function approvalRace() {
  const approval = Promise.withResolvers<boolean>(),
    entered = Promise.withResolvers<void>();
  const f = await backendFixture({
    evaluatePolicy: () => {
      entered.resolve();
      return approval.promise;
    },
  });
  await f.open();
  const scripts: string[] = [];
  f.requests.on("Runtime.evaluate", (message: unknown) => {
    const expression = z
      .object({ operation: z.object({ params: z.object({ expression: z.string() }) }) })
      .safeParse(message);
    if (expression.success && expression.data.operation.params.expression.includes("agent-script"))
      scripts.push(expression.data.operation.params.expression);
  });
  const evaluating = f.service.execute("thread", {
    action: "evaluate",
    expression: "'agent-script'",
  });
  await entered.promise;
  return { f, scripts, evaluating, approve: () => approval.resolve(true) };
}
it("an evaluation approved after the person kept agents out never reaches the desktop", async () => {
  const { f, scripts, evaluating, approve } = await approvalRace();
  keepAgentsOut(f.service, "thread");
  approve();
  await expect(evaluating).rejects.toMatchObject({ code: "human_private" });
  expect(scripts).toEqual([]);
});
it("an approved evaluation is dropped as stale when privacy changed during approval", async () => {
  const { f, scripts, evaluating, approve } = await approvalRace();
  keepAgentsOut(f.service, "thread");
  keepAgentsOut(f.service, "thread", false);
  approve();
  await expect(evaluating).rejects.toThrow();
  expect(scripts).toEqual([]);
});
it("native permission and download denials flow through bounded daemon logs", async () => {
  const f = await backendFixture();
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  f.sendEvent(sessionId, "ace.permissionDenied", {
    origin: "https://example.com",
    permission: "geolocation",
  });
  f.sendEvent(sessionId, "ace.downloadDenied", {
    url: "https://example.com/file",
    suggestedFilename: "file.bin",
  });
  await f.service.execute("thread", { action: "screenshot" });
  const paths = z
    .object({ entries: z.array(z.object({ text: z.string() })) })
    .parse(await f.service.execute("thread", { action: "logs" }));
  expect(paths.entries.some((entry) => entry.text.includes("geolocation"))).toBe(true);
  expect(paths.entries.some((entry) => entry.text.includes("file.bin"))).toBe(true);
});

it("holds relay commands over the limit until a slot frees and rejects them all on disconnect", async () => {
  const f = await backendFixture();
  const session = await f.backend.open({
    options: BrowserOpen.parse({ threadId: "raw", workspaceId: "workspace" }),
    profileDir: f.home,
    signal: new AbortController().signal,
    allowed: async () => true,
    navigation() {},
    log() {},
    lost() {},
  });
  f.hold("Runtime.getProperties");
  const sent: BrowserBackendRequest[] = [];
  f.requests.on("Runtime.getProperties", (request) => sent.push(request));
  const requests = Array.from({ length: 130 }, () =>
    session.cdp.send("Runtime.getProperties", { objectId: "1" }),
  );
  const finished = Promise.allSettled(requests);
  await expect.poll(() => sent.length).toBe(128);
  const first = sent[0];
  if (!first) throw new Error("Missing relayed request");
  f.reply(first, {});
  await expect.poll(() => sent.length).toBe(129);
  f.backend.disconnect("Disconnected with pending requests");
  const results = await finished;
  expect(results[0]?.status).toBe("fulfilled");
  expect(results.slice(1).every((result) => result.status === "rejected")).toBe(true);
  await expect(session.cdp.send("Memory.getDOMCounters")).rejects.toThrow("lost");
});
it("a host's evaluate hook and backend loss use the final redirected desktop URL", async () => {
  let approvalUrl = "";
  const f = await backendFixture({
    evaluatePolicy: (_thread, url) => {
      approvalUrl = url;
      return false;
    },
  });
  await f.open();
  f.redirect("http://localhost:3000/final");
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/start" });
  expect(f.service.state("thread").url).toBe("http://localhost:3000/final");
  await expect(
    f.service.execute("thread", { action: "evaluate", expression: "1" }),
  ).rejects.toThrow("refused");
  expect(approvalUrl).toBe("http://localhost:3000/final");
  await f.disconnect();
  expect(f.service.state("thread").url).toBe("http://localhost:3000/final");
});
