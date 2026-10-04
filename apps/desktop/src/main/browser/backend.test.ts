import { describe, expect, it, vi } from "vitest";
import { BrowserBackend, type ControllerState } from "./backend.ts";
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
function setup() {
  const views = fakeViews();
  const controllers: ControllerState[] = [];
  const takeovers: string[] = [];
  const backend = new BrowserBackend(views.host, {
    onController: (state) => controllers.push(state),
    onTakeover: (threadId) => takeovers.push(threadId),
    log: () => {},
  });
  const sent: BrowserBackendClientMessage[] = [];
  backend.attach({
    backendId: "backend-1",
    connectionId: "connection-1",
    send: (serialized) => {
      sent.push(BrowserBackendClientMessage.parse(JSON.parse(serialized)));
      return true;
    },
  });
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
  const open = async (sessionId = "s-1", threadId = "t-1") =>
    response(
      request(sessionId, {
        kind: "open",
        options: { threadId, workspaceId: "w-1", profile: "ephemeral" },
        viewport: { width: 1280, height: 720 },
        lease: { generation: 0, controller: "agent" },
      }),
    );
  return {
    backend,
    views,
    sent,
    controllers,
    takeovers,
    request,
    response,
    responses,
    frames,
    frameAck,
    open,
  };
}

describe("embedded browser backend", () => {
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

  it("lets the person use a view only under a human lease held by this app's connection", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    expect(page.nativeInput).toBe(false);

    const lease = (generation: number, controller: string, owner?: string) =>
      t.response(
        t.request("s-1", {
          kind: "controller",
          lease: { generation, controller, ...(owner ? { owner } : {}) },
        }),
      );
    await lease(1, "human", "connection-1");
    expect(page.nativeInput).toBe(true);
    expect(t.controllers.at(-1)).toEqual({ threadId: "t-1", controller: "human", here: true });

    // Another device's person holds it: native input here stays off.
    await lease(2, "human", "phone-connection");
    expect(page.nativeInput).toBe(false);
    expect(t.controllers.at(-1)).toMatchObject({ controller: "human", here: false });

    expect(await lease(1, "human", "connection-1")).toMatchObject({
      error: "Obsolete controller lease generation",
    });
    expect(page.nativeInput).toBe(false);

    await lease(3, "agent");
    expect(page.nativeInput).toBe(false);
  });

  it("lets the person's input through a renderer's claim only while the lease is its connection's", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    const lease = (generation: number, controller: string, owner?: string) =>
      t.response(
        t.request("s-1", {
          kind: "controller",
          lease: { generation, controller, ...(owner ? { owner } : {}) },
        }),
      );

    // Another device holds the page: the renderer's claim lets nothing through.
    await lease(1, "human", "phone-connection");
    t.backend.claimControl("t-1", "web-connection");
    expect(page.nativeInput).toBe(false);
    page.personClicks();
    expect(t.takeovers).toEqual(["t-1"]);
    // Its lease ends: the claim is revoked for good, even when the renderer's connection
    // takes control later without claiming again.
    await lease(2, "agent");
    await lease(3, "human", "web-connection");
    expect(page.nativeInput).toBe(false);
  });

  it("enables input once the renderer's own take-control lease arrives, and revokes it on handback", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    const lease = (generation: number, controller: string, owner?: string) =>
      t.response(
        t.request("s-1", {
          kind: "controller",
          lease: { generation, controller, ...(owner ? { owner } : {}) },
        }),
      );

    // The renderer claims as its take-control reply arrives, before the lease reaches here.
    t.backend.claimControl("t-1", "web-connection");
    expect(page.nativeInput).toBe(false);
    await lease(1, "human", "web-connection");
    expect(page.nativeInput).toBe(true);
    page.personClicks();
    expect(t.takeovers).toEqual([]);

    await lease(2, "agent");
    expect(page.nativeInput).toBe(false);
  });

  it("stops the person's input when the renderer no longer claims the page", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    await t.response(
      t.request("s-1", {
        kind: "controller",
        lease: { generation: 1, controller: "human", owner: "web-connection" },
      }),
    );
    t.backend.claimControl("t-1", "web-connection");
    expect(page.nativeInput).toBe(true);
    t.backend.claimControl("t-1", undefined);
    expect(page.nativeInput).toBe(false);
  });

  it("asks the daemon for control when the person uses a view they do not control", async () => {
    const t = setup();
    await t.open();
    const page = t.views.only();
    page.personClicks();
    expect(t.takeovers).toEqual(["t-1"]);

    await t.response(
      t.request("s-1", {
        kind: "controller",
        lease: { generation: 1, controller: "human", owner: "connection-1" },
      }),
    );
    page.personClicks();
    expect(t.takeovers).toEqual(["t-1"]);
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

  it("closes every view when the connection is lost, since the daemon never reuses a session", async () => {
    const t = setup();
    await t.open("s-1", "t-1");
    await t.open("s-2", "t-2");
    t.backend.detach();
    await vi.waitFor(() =>
      expect([...t.views.pages.values()].every((page) => page.closed)).toBe(true),
    );
    expect(t.controllers.slice(-2).map((state) => state.controller)).toEqual(["none", "none"]);
  });

  it("refuses a ninth view", async () => {
    const t = setup();
    for (let index = 1; index <= 8; index++) await t.open(`s-${index}`, `t-${index}`);
    expect(await t.open("s-9", "t-9")).toMatchObject({ error: "Embedded browser session limit" });
  });
});

function frameData(params: unknown): string {
  return typeof params === "object" && params !== null && "data" in params
    ? String(params.data)
    : "";
}
