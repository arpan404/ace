import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket as ServerSocket } from "ws";
import { EmbeddedBackend } from "@ace/browser";
import { BrowserOpen } from "@ace/protocol";
import { BrowserBackend } from "./backend.ts";
import { BackendConnection } from "./connection.ts";
import { readDesktopCredential } from "./credential.ts";
import { fakeViews, screencastFrame } from "./test-support.ts";

/**
 * The desktop backend against the daemon's own relay, `EmbeddedBackend` from `@ace/browser`,
 * over a real local socket. The socket server below only does what the daemon's socket
 * service does around the relay (hello, credential check, `registered`, routing); every
 * request, response, event and ack is the relay's own.
 */
const token = "a".repeat(64);
const credential = {
  device: {
    id: "desktop-browser",
    name: "ace desktop browser",
    scopes: ["desktop"],
    createdAt: 1,
    lastSeenAt: 1,
    revokedAt: null,
  },
  token: "b".repeat(64),
};

/** Real sockets and a real daemon: give them time, then fail with the last assertion. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function relayDaemon() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  const relays: EmbeddedBackend[] = [];
  const takeovers: string[] = [];
  let connections = 0;
  server.on("connection", (socket) => {
    const connectionId = `connection-${++connections}`;
    let relay: EmbeddedBackend | undefined;
    const reply = (message: unknown) => socket.send(JSON.stringify(message));
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "hello") {
        const valid =
          "token" in message &&
          message.token === token &&
          "deviceId" in message &&
          message.deviceId === credential.device.id;
        if (!valid) return socket.close();
        return reply({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
      }
      if (message.type === "ping") return reply({ type: "pong" });
      if (message.type === "browser.takeover" && "threadId" in message)
        return void takeovers.push(String(message.threadId));
      if (message.type === "browser.backend.register") {
        if (!("credential" in message) || message.credential !== credential.token)
          return reply({ type: "error", code: "browser_backend_denied", message: "denied" });
        relay = new EmbeddedBackend(
          `backend-${connections}`,
          {
            send: (outgoing, serialized) => {
              if (socket.readyState !== ServerSocket.OPEN) return false;
              socket.send(serialized ?? JSON.stringify(outgoing));
              return true;
            },
            close: (reason) => socket.close(4009, reason.slice(0, 120)),
          },
          () => {},
        );
        relays.push(relay);
        return reply({
          type: "browser.backend.registered",
          requestId: "requestId" in message ? message.requestId : "",
          backendId: `backend-${connections}`,
          connectionId,
        });
      }
      if (String(message.type).startsWith("browser.backend.")) relay?.handle(message);
    });
    socket.on("close", () => relay?.disconnect("Desktop app disconnected"));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `ws://127.0.0.1:${address.port}/`, relays, takeovers };
}

async function setup() {
  const daemon = await relayDaemon();
  const home = await mkdtemp(join(tmpdir(), "ace-desktop-relay-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "browser-desktop.json"), JSON.stringify(credential));
  const views = fakeViews();
  const backend = new BrowserBackend(views.host, {
    onTakeover: (threadId) => connection.takeover(threadId),
    log: () => {},
  });
  const connection = new BackendConnection(backend, {
    daemon: async () => ({ url: daemon.url, token }),
    credential: () => readDesktopCredential(home),
    socket: (url) => new WebSocket(url),
    timers: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    log: () => {},
  });
  cleanups.push(() => connection.close());
  connection.setAvailable(true);
  await eventually(() => expect(connection.state()).toBe("registered"));
  const relay = daemon.relays.at(-1);
  if (!relay) throw new Error("not registered");
  const lost: string[] = [];
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const session = await relay.open({
    options: BrowserOpen.parse({ threadId: "t-1", workspaceId: "w-1", profile: "ephemeral" }),
    profileDir: home,
    signal: abort.signal,
    allowed: async () => true,
    navigation: () => {},
    log: () => {},
    lost: (reason: string) => lost.push(reason),
  });
  return { daemon, views, connection, relay, session, lost, page: views.only() };
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

  it("turns the person's native input on only under a human lease for this app's connection", async () => {
    const { session, page } = await start();
    await session.controller({ generation: 1, controller: "human", owner: "connection-1" });
    expect(page.nativeInput).toBe(true);
    await session.controller({ generation: 2, controller: "human", owner: "connection-9" });
    expect(page.nativeInput).toBe(false);
    await expect(
      session.controller({ generation: 1, controller: "human", owner: "connection-1" }),
    ).rejects.toThrow();
    await session.controller({ generation: 3, controller: "agent" });
    expect(page.nativeInput).toBe(false);
  });

  it("asks the daemon for control when the person clicks a view the agent drives", async () => {
    const { daemon, page } = await start();
    page.personClicks();
    await eventually(() => expect(daemon.takeovers).toEqual(["t-1"]));
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

  it("closing the last window tells the daemon its sessions are gone and closes the views", async () => {
    const { connection, lost, page } = await start();
    connection.setAvailable(false);
    await eventually(() => expect(lost).toHaveLength(1));
    expect(page.closed).toBe(true);
    expect(connection.state()).toBe("off");
  });

  it("a view that dies on its own is reported lost to the daemon", async () => {
    const { lost, page } = await start();
    page.emit("Inspector.detached", { reason: "Render process gone" });
    await eventually(() => expect(lost).toEqual(["Desktop browser view closed"]));
  });
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
