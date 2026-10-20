import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { BrowserBackend, type BackendOptions } from "./backend.ts";
import {
  BrowserBackendClientMessage,
  BrowserBackendOperation,
  BrowserBackendServerMessage,
} from "@ace/protocol";
import { fakeViews, screencastFrame } from "./test-support.ts";

/**
 * The desktop side alone, behind an in-memory link. Every message it sends is parsed with
 * the wire schema, so a frame the daemon would reject fails here. The same behaviour is
 * exercised against the daemon's own relay in `relay.process.test.ts`.
 */
function setup(options: Partial<BackendOptions> = {}) {
  const views = fakeViews();
  const backend = new BrowserBackend(views.host, {
    log: () => {},
    ...options,
  });
  const sent: BrowserBackendClientMessage[] = [];
  /** A (new) daemon connection; the old one's sessions are gone, its pages orphaned. */
  const connect = (connectionId = "connection-1") =>
    backend.attach({
      backendId: "backend-1",
      connectionId,
      send: (serialized) => {
        sent.push(BrowserBackendClientMessage.parse(JSON.parse(serialized)));
        return true;
      },
    });
  connect();
  let sequence = 0;
  const request = (sessionId: string, operation: unknown) => {
    const id = `request-${++sequence}`;
    backend.handle(
      BrowserBackendServerMessage.parse({
        type: "browser.backend.request",
        backendId: "backend-1",
        sessionId,
        id,
        operation: BrowserBackendOperation.parse(operation),
      }),
    );
    return id;
  };
  const responses = (id: string) =>
    sent.filter((message) => message.type === "browser.backend.response" && message.id === id);
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses(id)).toHaveLength(1));
    return responses(id)[0];
  };
  const frames = () =>
    sent.flatMap((message) =>
      message.type === "browser.backend.event" && message.method === "Page.screencastFrame"
        ? [frameData(message.params)]
        : [],
    );
  const frameAck = (sessionId: string, frameId: number) =>
    backend.handle(
      BrowserBackendServerMessage.parse({
        type: "browser.backend.frameAck",
        backendId: "backend-1",
        sessionId,
        frameId,
      }),
    );
  const open = async (sessionId = "s-1", threadId = "t-1", profile = "ephemeral") =>
    response(
      request(sessionId, {
        kind: "open",
        options: { threadId, workspaceId: "w-1", profile },
        viewport: { width: 1280, height: 720 },
      }),
    );
  return {
    backend,
    connect,
    views,
    sent,
    request,
    response,
    responses,
    frames,
    frameAck,
    open,
  };
}

describe("embedded browser backend", () => {
  it("refuses to confirm a purge when its host cannot clear partitions", async () => {
    const t = setup();
    delete t.views.host.purge;
    const id = t.request("purge-1", { kind: "purge", threadId: "t-1", workspaceId: "w-1" });
    expect(await t.response(id)).toMatchObject({ error: "Browser partition purge unavailable" });
    expect(t.views.purged).toEqual([]);
  });

  it("opens a view for the daemon and answers each request once with its ids and the exact CDP result", async () => {
    const t = setup();
    expect(await t.open()).toMatchObject({
      backendId: "backend-1",
      sessionId: "s-1",
      result: { url: "about:blank" },
    });
    const id = t.request("s-1", {
      kind: "cdp",
      method: "Page.captureScreenshot",
      params: { format: "png" },
    });
    expect(await t.response(id)).toEqual({
      type: "browser.backend.response",
      backendId: "backend-1",
      sessionId: "s-1",
      id,
      result: { data: "AA==" },
    });
    expect(t.views.only().calls).toContainEqual({
      method: "Page.captureScreenshot",
      params: { format: "png" },
    });
    const navigated = t.request("s-1", {
      kind: "navigate",
      url: "http://localhost:5173/",
      timeout: 5_000,
    });
    expect(await t.response(navigated)).toMatchObject({
      result: { url: "http://localhost:5173/" },
    });
  });

  it("refuses a new view while the screen can't draw, and opens one once it can", async () => {
    let drawable = false;
    const t = setup({ drawable: () => drawable });
    expect(await t.open("s-1")).toMatchObject({ error: expect.stringContaining("locked") });
    expect(t.views.pages.size).toBe(0);
    drawable = true;
    expect(await t.open("s-2")).toMatchObject({ result: { url: "about:blank" } });
  });

  it("answers requests for a session it does not have with an error", async () => {
    const t = setup();
    const id = t.request("missing", { kind: "cdp", method: "Page.reload" });
    expect(await t.response(id)).toMatchObject({ error: "Unknown browser session" });
  });

  it("keeps one screencast frame in flight and sends only the newest waiting one after each ack", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    for (const [frameId, data] of [
      [1, "f1"],
      [2, "f2"],
      [3, "f3"],
      [4, "f4"],
    ] as const)
      page.emit("Page.screencastFrame", screencastFrame(frameId, data));
    expect(t.frames()).toEqual(["f1"]);
    // Chromium gets its own ack for every frame at once, so capture never stalls.
    expect(page.acks()).toBe(4);

    t.frameAck("s-1", 3); // not the frame in flight
    expect(t.frames()).toEqual(["f1"]);
    t.frameAck("s-1", 1);
    expect(t.frames()).toEqual(["f1", "f4"]);
    t.frameAck("s-1", 4);
    expect(t.frames()).toEqual(["f1", "f4"]);
  });

  it("never sends a frame larger than the relay accepts", async () => {
    const t = setup();
    await t.open();
    t.views.only().emit("Page.screencastFrame", screencastFrame(1, "x".repeat(800 * 1024)));
    expect(t.frames()).toEqual([]);
    expect(t.views.only().acks()).toBe(1);
  });

  it("lets the person use the view at once and tells the daemon when they do", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    expect(page.nativeInput).toBe(true);
    page.personClicks();
    expect(
      t.sent.filter(
        (message) =>
          message.type === "browser.backend.event" && message.method === "ace.humanInput",
      ),
    ).toEqual([expect.objectContaining({ sessionId: "s-1", params: {} })]);
  });

  it("follows the daemon's word on whether an agent uses the shown view", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    expect(page.agentControl).toBe(false);
    await t.response(t.request("s-1", { kind: "agentUse", active: true }));
    expect(page.agentControl).toBe(true);
    // The person keeps their input while the agent works.
    expect(page.nativeInput).toBe(true);
    await t.response(t.request("s-1", { kind: "agentUse", active: false }));
    expect(page.agentControl).toBe(false);
  });

  it("answers a result over the relay limit with an error instead of leaving the request open", async () => {
    const t = setup();
    await t.open();
    t.views.only().results.set("DOM.getOuterHTML", { outerHTML: "x".repeat(1024 * 1024) });
    const id = t.request("s-1", { kind: "cdp", method: "DOM.getOuterHTML" });
    expect(await t.response(id)).toMatchObject({ error: "Browser relay payload limit" });
    expect(t.responses(id)).toHaveLength(1);
  });

  it("forwards page events, and reports a view that died on its own before forgetting it", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    page.emit("Fetch.requestPaused", { requestId: "r-1", request: { url: "https://a.test/" } });
    page.emit("Inspector.detached", { reason: "Render process gone" });
    expect(
      t.sent.flatMap((message) =>
        message.type === "browser.backend.event" ? [message.method] : [],
      ),
    ).toEqual(["Fetch.requestPaused", "Inspector.detached"]);
    await vi.waitFor(() => expect(page.closed).toBe(true));

    const id = t.request("s-1", { kind: "cdp", method: "Page.reload" });
    expect(await t.response(id)).toMatchObject({ error: "Unknown browser session" });
  });

  it("a lost connection keeps every page, and the next daemon adopts it by thread instead of opening another", async () => {
    const t = setup();
    await t.open("s-1", "t-1");
    await t.open("s-2", "t-2");
    const first = t.views.pages.get("s-1");
    await first?.navigate("https://kept.test/");
    t.backend.detach();
    expect([...t.views.pages.values()].map((page) => [page.closed, page.orphaned])).toEqual([
      [false, true],
      [false, true],
    ]);
    t.connect("connection-2");
    // The daemon never reuses a session id: the new one names the thread.
    expect(await t.open("s-3", "t-1")).toMatchObject({
      result: { url: "https://kept.test/", adopted: true },
    });
    expect(t.views.opened).toHaveLength(2);
    expect(first).toMatchObject({ closed: false, orphaned: false, adoptions: 1 });
    const id = t.request("s-3", { kind: "cdp", method: "Runtime.evaluate" });
    expect(await t.response(id)).toMatchObject({ sessionId: "s-3", result: {} });
    const old = t.request("s-1", { kind: "cdp", method: "Runtime.evaluate" });
    expect(await t.response(old)).toMatchObject({ error: "Unknown browser session" });
  });

  it("a page nobody adopts within the grace period closes", async () => {
    const expire: (() => void)[] = [];
    const t = setup({
      timers: {
        set(_delayMs, callback) {
          expire.push(callback);
          return () => {};
        },
      },
    });
    await t.open("s-1", "t-1");
    t.backend.detach();
    expect(t.views.only().closed).toBe(false);
    for (const run of expire) run();
    await vi.waitFor(() => expect(t.views.only().closed).toBe(true));
    t.connect("connection-2");
    expect(await t.open("s-2", "t-1")).not.toMatchObject({ result: { adopted: true } });
    expect(t.views.opened).toHaveLength(2);
  });

  it("an open for another profile of the thread gets a fresh page and the orphan closes", async () => {
    const t = setup();
    await t.open("s-1", "t-1", "ephemeral");
    const orphan = t.views.only();
    t.backend.detach();
    t.connect("connection-2");
    expect(await t.open("s-2", "t-1", "persistent")).not.toMatchObject({
      result: { adopted: true },
    });
    expect(orphan.closed).toBe(true);
    expect(t.views.opened).toHaveLength(2);
  });

  it("Quit closes the pages still waiting to be adopted", async () => {
    const t = setup();
    await t.open("s-1", "t-1");
    t.backend.detach();
    t.backend.closeAll();
    await vi.waitFor(() => expect(t.views.only().closed).toBe(true));
  });

  it("answers a command for a view that closed underneath it with that request's error", async () => {
    const t = setup();
    await t.open();
    // The view is destroyed before Electron reports the detach.
    t.views.only().closed = true;
    const id = t.request("s-1", { kind: "cdp", method: "Runtime.evaluate" });
    expect(await t.response(id)).toMatchObject({ sessionId: "s-1", error: "Browser view closed" });
  });

  it("purges a deleted thread's partition without an open session, closing its view first", async () => {
    const t = setup();
    await t.open("s-1", "t-1");
    await t.open("s-2", "t-2");
    const id = t.request("purge-1", { kind: "purge", threadId: "t-1", workspaceId: "w-1" });
    expect(await t.response(id)).toMatchObject({ sessionId: "purge-1", result: {} });
    expect(t.views.purged).toEqual([{ threadId: "t-1", workspaceId: "w-1" }]);
    expect(t.views.pages.get("s-1")?.closed).toBe(true);
    expect(t.views.pages.get("s-2")?.closed).toBe(false);
    const after = t.request("s-1", { kind: "cdp", method: "Page.reload" });
    expect(await t.response(after)).toMatchObject({ error: "Unknown browser session" });
  });

  it("reports a partition it could not clear, so the daemon retries the purge", async () => {
    const t = setup();
    t.views.failPurge("Browser partition could not be cleared");
    const id = t.request("purge-1", { kind: "purge", threadId: "t-1", workspaceId: "w-1" });
    expect(await t.response(id)).toMatchObject({
      error: "Browser partition could not be cleared",
    });
  });

  it("hosts 32 views at once and refuses a 33rd", async () => {
    const t = setup();
    for (let index = 1; index <= 32; index++)
      expect(await t.open(`s-${index}`, `t-${index}`)).not.toHaveProperty("error");
    expect(await t.open("s-33", "t-33")).toMatchObject({ error: "Embedded browser session limit" });
  });
});

function frameData(params: unknown): string {
  return typeof params === "object" && params !== null && "data" in params
    ? String(params.data)
    : "";
}

it("relays every trace event in bounded batches and reports an individually oversized event", async () => {
  const t = setup();
  await t.open();
  const events = Array.from({ length: 20 }, (_, index) => ({
    name: "DrawFrame",
    ts: index,
    payload: "x".repeat(70_000),
  }));
  t.views.only().emit("Tracing.dataCollected", { value: events });
  const batches = t.sent.filter(
    (message) =>
      message.type === "browser.backend.event" && message.method === "Tracing.dataCollected",
  );
  const values = batches.flatMap((message) =>
    message.type === "browser.backend.event"
      ? z.object({ value: z.array(z.unknown()) }).parse(message.params).value
      : [],
  );
  expect(values).toEqual(events);
  for (const batch of batches)
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(1024 * 1024);
  t.views
    .only()
    .emit("Tracing.dataCollected", { value: [{ name: "huge", payload: "x".repeat(300_000) }] });
  expect(t.sent.at(-1)).toMatchObject({
    type: "browser.backend.event",
    method: "Tracing.dataCollected",
    params: { value: [], aceTruncated: true },
  });
  t.backend.detach();
});
