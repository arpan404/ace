import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { BackendUp, FrameChannel } from "./contract.ts";
import { BrowserBackend, type CdpTarget, type ViewHost } from "./backend.ts";

/** A fake daemon on a real local socket: records what the backend sends, sends it frames. */
async function fakeDaemon() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  const received: BackendUp[] = [];
  const waiters = new Set<() => void>();
  let socket: ServerSocket | undefined;
  server.on("connection", (connection) => {
    socket = connection;
    connection.on("message", (data) => {
      received.push(JSON.parse(String(data)) as BackendUp);
      for (const wake of waiters) wake();
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    received,
    send(frame: unknown) {
      socket?.send(JSON.stringify(frame));
    },
    drop() {
      socket?.terminate();
    },
    async waitFor<T extends BackendUp["type"]>(
      type: T,
      match: (frame: Extract<BackendUp, { type: T }>) => boolean = () => true,
    ): Promise<Extract<BackendUp, { type: T }>> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const found = received.find(
          (frame): frame is Extract<BackendUp, { type: T }> =>
            frame.type === type && match(frame as Extract<BackendUp, { type: T }>),
        );
        if (found) return found;
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 25);
        });
      }
      throw new Error(`No ${type} frame`);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The production channel rides the desktop link's socket; tests use a bare one. */
function socketChannel(url: string) {
  let socket: WebSocket | undefined;
  const frames = new Set<(frame: unknown) => void>();
  const ready = new Set<() => void>();
  const closed = new Set<() => void>();
  const connect = () => {
    socket = new WebSocket(url);
    socket.addEventListener("open", () => ready.forEach((listener) => listener()));
    socket.addEventListener("message", (event) =>
      frames.forEach((listener) => listener(JSON.parse(String(event.data)))),
    );
    socket.addEventListener("close", () => closed.forEach((listener) => listener()));
  };
  const channel: FrameChannel = {
    send: (frame) => socket?.send(JSON.stringify(frame)),
    onFrame: (listener) => (frames.add(listener), () => frames.delete(listener)),
    onReady: (listener) => (ready.add(listener), () => ready.delete(listener)),
    onClose: (listener) => (closed.add(listener), () => closed.delete(listener)),
  };
  return { channel, connect, close: () => socket?.close() };
}

/** Embedded views without Electron: records CDP calls and lets tests emit events or input. */
function fakeViews() {
  const targets = new Map<string, FakeTarget>();
  class FakeTarget implements CdpTarget {
    calls: { method: string; params: Record<string, unknown> }[] = [];
    closed = false;
    events = new Set<(method: string, params: Record<string, unknown>) => void>();
    input = new Set<() => void>();
    address: string;
    constructor(address: string) {
      this.address = address;
    }
    async send(method: string, params: Record<string, unknown>) {
      this.calls.push({ method, params });
      if (method === "Page.captureScreenshot") return { data: "c2NyZWVu" };
      return {};
    }
    onEvent(listener: (method: string, params: Record<string, unknown>) => void) {
      this.events.add(listener);
      return () => this.events.delete(listener);
    }
    onHumanInput(listener: () => void) {
      this.input.add(listener);
      return () => this.input.delete(listener);
    }
    url() {
      return this.address;
    }
    close() {
      this.closed = true;
    }
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of this.events) listener(method, params);
    }
    human() {
      for (const listener of this.input) listener();
    }
  }
  const host: ViewHost = {
    open(request) {
      const target = new FakeTarget(request.url ?? "about:blank");
      targets.set(request.sessionId, target);
      return target;
    },
  };
  return { host, targets };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup() {
  const daemon = await fakeDaemon();
  const views = fakeViews();
  const socket = socketChannel(daemon.url);
  const controllers: string[] = [];
  const backend = new BrowserBackend(socket.channel, views.host, {
    now: Date.now,
    onController: (sessionId, controller) => controllers.push(`${sessionId}:${controller}`),
  });
  socket.connect();
  cleanups.push(
    () => daemon.close(),
    () => socket.close(),
  );
  await daemon.waitFor("browser.backend.register");
  return { daemon, views, socket, backend, controllers };
}

async function openSession(daemon: Awaited<ReturnType<typeof fakeDaemon>>, sessionId = "s-1") {
  daemon.send({
    type: "browser.backend.open",
    sessionId,
    workspaceId: "w-1",
    url: "http://localhost:5173/",
  });
  await daemon.waitFor("browser.backend.opened", (frame) => frame.sessionId === sessionId);
}

describe("embedded browser backend", () => {
  it("registers as the embedded backend when the daemon connection is ready", async () => {
    const { daemon } = await setup();
    expect(daemon.received[0]).toEqual({
      type: "browser.backend.register",
      backend: "embedded",
      version: 1,
      capabilities: { screencast: true, input: true, takeover: true },
      sessions: [],
    });
  });

  it("relays CDP calls to the view and returns the results", async () => {
    const { daemon, views } = await setup();
    await openSession(daemon);
    daemon.send({
      type: "browser.backend.call",
      sessionId: "s-1",
      callId: 7,
      method: "Page.captureScreenshot",
      params: { format: "png" },
    });
    expect(await daemon.waitFor("browser.backend.result", (frame) => frame.callId === 7)).toEqual({
      type: "browser.backend.result",
      sessionId: "s-1",
      callId: 7,
      result: { data: "c2NyZWVu" },
    });
    expect(views.targets.get("s-1")?.calls).toContainEqual({
      method: "Page.captureScreenshot",
      params: { format: "png" },
    });
  });

  it("forwards page events and ignores CDP noise", async () => {
    const { daemon, views } = await setup();
    await openSession(daemon);
    const target = views.targets.get("s-1");
    target?.emit("DOM.attributeModified", { nodeId: 1 });
    target?.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "ready" }] });
    const event = await daemon.waitFor("browser.backend.event");
    expect(event).toMatchObject({ method: "Runtime.consoleAPICalled", sessionId: "s-1" });
    expect(
      daemon.received.some(
        (frame) => "method" in frame && frame.method === "DOM.attributeModified",
      ),
    ).toBe(false);
  });

  it("sends only the latest screencast frame while the daemon has not acknowledged", async () => {
    const { daemon, views } = await setup();
    await openSession(daemon);
    daemon.send({ type: "browser.backend.screencast", sessionId: "s-1", enabled: true });
    const target = views.targets.get("s-1");
    await expectEventually(() =>
      target?.calls.some((call) => call.method === "Page.startScreencast"),
    );
    for (const data of ["f0", "f1", "f2", "f3"])
      target?.emit("Page.screencastFrame", { data, sessionId: 1, metadata: {} });
    await daemon.waitFor("browser.backend.frame");
    daemon.send({ type: "browser.backend.ack", sessionId: "s-1", seq: 0 });
    await daemon.waitFor("browser.backend.frame", (frame) => frame.data === "f3");
    const frames = daemon.received.flatMap((frame) =>
      frame.type === "browser.backend.frame" ? [frame.data] : [],
    );
    expect(frames).toEqual(["f0", "f3"]);
    // Chrome gets its own ack for every frame so the stream keeps flowing.
    expect(target?.calls.filter((call) => call.method === "Page.screencastFrameAck")).toHaveLength(
      4,
    );
  });

  it("hands control to the person on input and back to the agent on hand-back", async () => {
    const { daemon, views, controllers } = await setup();
    await openSession(daemon);
    views.targets.get("s-1")?.human();
    await daemon.waitFor("browser.backend.controller", (frame) => frame.controller === "human");

    daemon.send({
      type: "browser.backend.call",
      sessionId: "s-1",
      callId: 1,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 1, y: 1 },
    });
    daemon.send({
      type: "browser.backend.call",
      sessionId: "s-1",
      callId: 2,
      method: "Accessibility.getFullAXTree",
      params: {},
    });
    expect(
      await daemon.waitFor("browser.backend.result", (frame) => frame.callId === 1),
    ).toMatchObject({ error: "human_in_control" });
    expect(
      await daemon.waitFor("browser.backend.result", (frame) => frame.callId === 2),
    ).toMatchObject({ result: {} });

    daemon.send({ type: "browser.backend.handback", sessionId: "s-1" });
    await daemon.waitFor("browser.backend.controller", (frame) => frame.controller === "agent");
    daemon.send({
      type: "browser.backend.call",
      sessionId: "s-1",
      callId: 3,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 1, y: 1 },
    });
    expect(
      await daemon.waitFor("browser.backend.result", (frame) => frame.callId === 3),
    ).toMatchObject({ result: {} });
    expect(controllers).toEqual(["s-1:human", "s-1:agent"]);
  });

  it("re-registers with its live sessions after the daemon connection drops", async () => {
    const { daemon, socket } = await setup();
    await openSession(daemon);
    daemon.drop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.connect();
    await daemon.waitFor("browser.backend.register", (frame) => frame.sessions.length === 1);
    expect(daemon.received.at(-1)).toMatchObject({
      type: "browser.backend.register",
      sessions: [{ sessionId: "s-1", url: "http://localhost:5173/" }],
    });
  });

  it("tells the daemon its sessions are gone when the app quits, so it can fail over", async () => {
    const { daemon, views, backend } = await setup();
    await openSession(daemon);
    backend.shutdown();
    await daemon.waitFor("browser.backend.unregister");
    expect(daemon.received.slice(-2)).toEqual([
      { type: "browser.backend.closed", sessionId: "s-1", reason: "quit" },
      { type: "browser.backend.unregister", reason: "quit" },
    ]);
    expect(views.targets.get("s-1")?.closed).toBe(true);
  });

  it("asks the daemon before loading a new origin and denies when the connection drops", async () => {
    const { daemon, backend } = await setup();
    await openSession(daemon);
    const allowed = backend.requestOrigin("s-1", "https://example.com");
    const request = await daemon.waitFor("browser.backend.origin");
    daemon.send({
      type: "browser.backend.originDecision",
      sessionId: "s-1",
      requestId: request.requestId,
      allowed: true,
    });
    expect(await allowed).toBe(true);

    const pending = backend.requestOrigin("s-1", "https://tracker.example");
    await daemon.waitFor(
      "browser.backend.origin",
      (frame) => frame.origin === "https://tracker.example",
    );
    daemon.drop();
    expect(await pending).toBe(false);
  });
});

async function expectEventually(check: () => boolean | undefined) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}
