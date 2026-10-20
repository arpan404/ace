import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { WebSocketServer, WebSocket as ServerSocket } from "ws";
import { EmbeddedBackend, type EmbeddedTransport } from "@ace/browser";
import { BrowserBackend, type ViewHost } from "./backend.ts";
import type { VideoRelaySource } from "./video-relay.ts";
import { BackendConnection } from "./connection.ts";
import { readDesktopCredential } from "./credential.ts";

/**
 * A stand-in daemon socket around the daemon's own relay, `EmbeddedBackend` from `@ace/browser`.
 * It only does what the daemon's socket service does around the relay (hello, credential check,
 * `registered`, routing); every request, response, event and ack is the relay's own.
 */
export const token = "a".repeat(64);
export const credential = {
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
export const eventually = (check: () => void) =>
  vi.waitFor(check, { timeout: 10_000, interval: 20 });

export interface RelayClock {
  now(): number;
  set(delayMs: number, work: () => void): () => void;
}

/**
 * `register` stands for the daemon's registration: a bare relay by default, or a whole
 * `BrowserService` (`service.registerEmbedded`) when a test drives the daemon's tab runtime.
 */
export async function relayDaemon(
  cleanups: (() => unknown)[],
  options: {
    clock?: RelayClock | undefined;
    register?: (backendId: string, transport: EmbeddedTransport) => EmbeddedBackend;
    /** Every message the desktop sends, as the daemon's socket receives it. */
    received?: (message: unknown) => void;
  } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  const relays: EmbeddedBackend[] = [];
  const sockets: ServerSocket[] = [];
  let connections = 0;
  const register =
    options.register ??
    ((backendId: string, transport: EmbeddedTransport) =>
      new EmbeddedBackend(backendId, transport, () => {}, options.clock));
  server.on("connection", (socket) => {
    sockets.push(socket);
    const connectionId = `connection-${++connections}`;
    let relay: EmbeddedBackend | undefined;
    const reply = (message: unknown) => socket.send(JSON.stringify(message));
    socket.on("message", (data, binary) => {
      // The desktop's video encoder events, as the daemon's browser socket service routes them.
      if (binary) {
        relay?.binary(new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
        return;
      }
      const message: unknown = JSON.parse(String(data));
      options.received?.(message);
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
      if (message.type === "browser.backend.register") {
        if (!("credential" in message) || message.credential !== credential.token)
          return reply({ type: "error", code: "browser_backend_denied", message: "denied" });
        relay = register(`backend-${connections}`, {
          send: (outgoing, serialized) => {
            if (socket.readyState !== ServerSocket.OPEN) return false;
            socket.send(serialized ?? JSON.stringify(outgoing));
            return true;
          },
          close: (reason) => socket.close(4009, reason.slice(0, 120)),
          video:
            "capabilities" in message &&
            typeof message.capabilities === "object" &&
            message.capabilities !== null &&
            "video" in message.capabilities &&
            message.capabilities.video === true,
        });
        relays.push(relay);
        return reply({
          type: "browser.backend.registered",
          requestId: "requestId" in message ? message.requestId : "",
          backendId: relay.id,
          connectionId,
        });
      }
      if (String(message.type).startsWith("browser.backend.")) relay?.handle(message);
    });
    socket.on("close", () => relay?.disconnect("Desktop app disconnected"));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  /** The link blips: the daemon's end of the newest socket drops without a goodbye. */
  const drop = () => sockets.at(-1)?.terminate();
  return { url: `ws://127.0.0.1:${address.port}/`, relays, drop };
}

/** The desktop's real backend and connection, registered with `daemon` over the socket. */
export async function connectDesktop(
  cleanups: (() => unknown)[],
  daemon: { url: string },
  host: ViewHost,
  /** The app's video encoder: the desktop then registers the `video` capability. */
  video?: VideoRelaySource,
) {
  const home = await mkdtemp(join(tmpdir(), "ace-desktop-relay-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "browser-desktop.json"), JSON.stringify(credential));
  const backend = new BrowserBackend(host, { log: () => {}, ...(video ? { video } : {}) });
  const connection = new BackendConnection(
    backend,
    {
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
    },
    { video: video !== undefined },
  );
  cleanups.push(() => connection.close());
  connection.setAvailable(true);
  await eventually(() => expect(connection.state()).toBe("registered"));
  return { home, connection };
}
