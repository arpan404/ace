import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { backendFixture } from "./backend-test-support.ts";
import {
  BrowserOpen,
  type BrowserFrame,
  type BrowserState,
  type BrowserBackendLost,
} from "@ace/protocol";

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
it("shares controller ownership with the socket backend and blocks stale agent input", async () => {
  const f = await backendFixture();
  await f.open();
  const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
    ?.ref;
  if (!ref) throw new Error("Missing ref");
  f.service.takeover("thread", "human");
  await expect(f.service.execute("thread", { action: "type", ref, text: "agent" })).rejects.toThrow(
    "controlled by human",
  );
  await expect(
    f.service.input("thread", { kind: "key", event: "char", key: "x" }, "other"),
  ).rejects.toThrow("mismatch");
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "human");
  const page = [...f.pages.values()][0];
  expect(page?.text).toBe("x");
  expect(page?.lease).toMatchObject({ controller: "human", owner: "human" });
  f.service.handback("thread", "human");
  await f.service.execute("thread", { action: "type", ref, text: "agent" });
  expect(page?.text).toBe("xagent");
  expect(page?.lease).toMatchObject({ controller: "agent", generation: 2 });
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
    { send: () => true },
    (state) => states.push(state),
    (event) => events.push(event),
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
  expect(states.at(-1)).toMatchObject({ controller: "none", status: "paused" });
  await expect(f.service.execute("thread", { action: "scroll", x: 0, y: 1 })).rejects.toMatchObject(
    { code: "browser_paused" },
  );
  expect(f.headless.pages).toHaveLength(0);
});
it("headless recovery preserves human ownership and invalidates old refs while reporting lost state", async () => {
  const f = await backendFixture({ backendLoss: () => "headless" });
  await f.service.open({ threadId: "thread", workspaceId: "workspace", profile: "persistent" });
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
    ?.ref;
  f.service.takeover("thread", "human");
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "human");
  const ready = Promise.withResolvers<void>();
  const frames: BrowserFrame[] = [];
  f.service.subscribe(
    "thread",
    "viewer",
    {
      send: (frame) => {
        frames.push(frame);
        f.service.acknowledge("thread", "viewer", frame.sequence);
        return true;
      },
    },
    (state) => {
      if (state.backend === "headless" && state.status === "ready") ready.resolve();
    },
  );
  await f.disconnect();
  await ready.promise;
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    url: "http://localhost:3000/page",
    controller: "human",
    owner: "human",
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
  ).rejects.toThrow("ref");
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.at(-1)?.sequence).toBeGreaterThan(frames[0]?.sequence ?? 0);
  await expect(f.service.execute("thread", { action: "scroll", x: 0, y: 1 })).rejects.toThrow(
    "controlled by human",
  );
});
it.each(["embedded", "headless"] as const)(
  "%s sessions preserve policy, refs, screenshot bytes and console logs",
  async (backend) => {
    const f = await backendFixture({ backendPreference: () => backend });
    await f.open();
    const ref = snapshot.parse(await f.service.execute("thread", { action: "snapshot" })).nodes[0]
      ?.ref;
    await expect(
      f.service.execute("thread", { action: "evaluate", expression: "1" }),
    ).rejects.toThrow("approval");
    await expect(
      f.service.execute("thread", { action: "navigate", url: "https://example.invalid" }),
    ).rejects.toThrow("approval");
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
      .object({ console: z.string() })
      .parse(await f.service.execute("thread", { action: "logs" }));
    expect(await readFile(logs.console, "utf8")).toContain("marker");
    await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000" });
    await expect(f.service.execute("thread", { action: "click", ref })).rejects.toThrow("ref");
  },
);
it("acknowledges desktop frames independently of a slow viewer and delivers only its latest pending frame", async () => {
  let now = 0;
  const f = await backendFixture({ now: () => (now += 200) });
  await f.open();
  const frames: BrowserFrame[] = [];
  f.service.subscribe(
    "thread",
    "slow",
    {
      send: (frame) => {
        frames.push(frame);
        return true;
      },
    },
    () => {},
  );
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  for (const frameId of [1, 2, 3]) {
    const ack = once(f.requests, "browser.backend.frameAck");
    f.sendEvent(sessionId, "Page.screencastFrame", {
      sessionId: frameId,
      data: String(frameId),
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    });
    await ack;
  }
  expect(frames).toHaveLength(1);
  f.service.acknowledge("thread", "slow", frames[0]?.sequence ?? -1);
  expect(frames.map((frame) => frame.data)).toEqual(["AA==", "3"]);
});
it("closes a pressured relay and pauses its session instead of queuing undelivered input", async () => {
  const f = await backendFixture();
  await f.open();
  const active = f.service.state("thread");
  f.pressure();
  await expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow("backpressure");
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
it("requires evaluation approval before sending arbitrary JavaScript to the desktop", async () => {
  const { f, scripts, evaluating, approve } = await approvalRace();
  f.service.takeover("thread", "human");
  approve();
  // The person still holds the page, so the agent is told why, not just that control moved.
  await expect(evaluating).rejects.toMatchObject({
    code: "human_controlled",
    message: "Browser controlled by human",
  });
  expect(scripts).toEqual([]);
});
it("an approved evaluation is dropped as stale when control changed hands during approval", async () => {
  const { f, scripts, evaluating, approve } = await approvalRace();
  f.service.takeover("thread", "human");
  f.service.handback("thread", "human");
  approve();
  await expect(evaluating).rejects.toMatchObject({ code: "controller_changed" });
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
    .object({ console: z.string(), network: z.string() })
    .parse(await f.service.execute("thread", { action: "logs" }));
  expect(await readFile(paths.console, "utf8")).toContain("permission.denied");
  expect(await readFile(paths.network, "utf8")).toContain("download.denied");
});

it("bounds outstanding relay commands and rejects every pending result on disconnect", async () => {
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
  const requests = Array.from({ length: 128 }, () =>
    session.cdp.send("Runtime.getProperties", { objectId: "1" }),
  );
  const finished = Promise.allSettled(requests);
  await expect(session.cdp.send("Runtime.getProperties", { objectId: "1" })).rejects.toThrow(
    "request limit",
  );
  f.backend.disconnect("Disconnected with pending requests");
  expect((await finished).every((result) => result.status === "rejected")).toBe(true);
  await expect(session.cdp.send("Memory.getDOMCounters")).rejects.toThrow("lost");
});
it("evaluation approval and backend loss use the final redirected desktop URL", async () => {
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
  ).rejects.toThrow("approval");
  expect(approvalUrl).toBe("http://localhost:3000/final");
  await f.disconnect();
  expect(f.service.state("thread").url).toBe("http://localhost:3000/final");
});
