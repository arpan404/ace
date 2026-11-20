import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  Socket,
  connect,
} from "node:net";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { loopbackConnection } from "./loopback.ts";
import { createMux, systemTimer, type PreviewChannel } from "./relay-mux.ts";
import { openPreviewProxy as openPortableProxy, type PreviewLoopbackRuntime } from "./transport.ts";
import { forwardHttp, forwardUpgrade, type Track } from "./forward.ts";
import { previewSocket } from "./node-socket.ts";
export type { PreviewChannel } from "./relay-mux.ts";

const cap = (value: number | undefined) =>
  z
    .number()
    .int()
    .min(1)
    .max(512)
    .parse(value ?? 256);
export function attachPreviewRelay(options: {
  channel: PreviewChannel;
  allowPort: (port: number, id: number) => Promise<boolean>;
  /** Admits an OPEN synchronously, before its socket exists; false resets it unopened. */
  admitOpen?: (port: number, id: number) => boolean;
  /**
   * Asked synchronously as stream `id`'s socket connects, after `allowPort`; false destroys the
   * socket unconnected, which resets the stream. Nothing runs between this and the connect.
   */
  canConnect?: (port: number, id: number) => boolean;
  maxStreams?: number;
  onClosed?: () => void;
  /**
   * Stream `id` left the mux, however it ended (refused streams' too): synchronously, so its
   * slot is free before the peer can hear its RESET and open again.
   */
  onStreamClosed?: (id: number) => void;
}) {
  return createMux({
    channel: options.channel,
    allowPort: options.allowPort,
    maxStreams: cap(options.maxStreams),
    timer: systemTimer,
    ...(options.onClosed ? { onClosed: options.onClosed } : {}),
    ...(options.admitOpen ? { admitOpen: options.admitOpen } : {}),
    ...(options.onStreamClosed ? { onStreamRemoved: options.onStreamClosed } : {}),
    socketFactory: (port, id) => {
      const socket = new Socket({ allowHalfOpen: true });
      // Again once connected, before READY (registered ahead of the mux's own listener): the
      // connect may have moved to the other loopback family after the first check.
      const canConnect = options.canConnect;
      if (canConnect)
        socket.once("connect", () => {
          if (!canConnect(port, id)) socket.destroy();
        });
      return {
        socket: previewSocket(socket, systemTimer),
        connect: () => {
          if (options.canConnect && !options.canConnect(port, id)) socket.destroy();
          else socket.connect(loopbackConnection(port));
        },
      };
    },
  });
}
async function listen(server: TcpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback listener has no port");
  return address.port;
}
export async function openPreviewProxy(options: {
  channel: PreviewChannel;
  port: number;
  maxStreams?: number;
}) {
  return openPortableProxy({
    ...options,
    runtime: { listen: createNodeLoopback },
  });
}

async function createNodeLoopback(options: Parameters<PreviewLoopbackRuntime["listen"]>[0]) {
  const { port, maxStreams } = options;
  const sockets = new Set<Socket>();
  const cancels = new Set<() => void>();
  const bridgeKey = randomBytes(32);
  const bridge = createTcpServer({ allowHalfOpen: true }, (socket) => {
    const prefix = Buffer.alloc(bridgeKey.length);
    let offset = 0;
    socket.setTimeout(15_000, () => socket.destroy());
    const authenticate = (chunk: Buffer) => {
      const bytes = Math.min(prefix.length - offset, chunk.length);
      chunk.copy(prefix, offset, 0, bytes);
      offset += bytes;
      if (offset !== prefix.length) return;
      socket.pause();
      socket.removeListener("data", authenticate);
      if (!timingSafeEqual(prefix, bridgeKey)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(0);
      if (bytes < chunk.length) socket.unshift(chunk.subarray(bytes));
      options.openSocket(previewSocket(socket, systemTimer));
    };
    socket.on("error", () => socket.destroy());
    socket.on("data", authenticate);
  });
  const browser = createHttpServer({ maxHeaderSize: 16_384 });
  const track: Track = (cancel) => {
    cancels.add(cancel);
    return () => cancels.delete(cancel);
  };
  for (const server of [bridge, browser]) {
    server.maxConnections = maxStreams;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("error", options.onFailure);
  }
  const close = async () => {
    for (const cancel of cancels) cancel();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [bridge, browser]
        .filter((s) => s.listening)
        .map((s) => new Promise<void>((done) => s.close(() => done()))),
    );
  };
  try {
    const bridgePort = await listen(bridge);
    const browserPort = await listen(browser);
    const host = `p${port}-${randomBytes(16).toString("hex")}.localhost:${browserPort}`;
    const url = `http://${host}`;
    const target = {
      port,
      origin: url,
      connect: () => {
        const socket = connect(bridgePort, "127.0.0.1");
        socket.write(bridgeKey); // Queue the capability before HTTP writes attach.
        return socket;
      },
    };
    browser.headersTimeout = 15_000;
    browser.requestTimeout = 0;
    const valid = (req: import("node:http").IncomingMessage) =>
      req.headers.host === host &&
      (!req.headers.origin || req.headers.origin === url) &&
      req.url?.startsWith("/") &&
      !req.url.startsWith("//");
    browser.on("request", (req, res) => {
      if (!valid(req) || cancels.size >= maxStreams) {
        res.writeHead(403);
        res.end();
        return;
      }
      forwardHttp(req, res, target, track);
    });
    browser.on("upgrade", (req, socket, head) => {
      socket.pause();
      if (
        !valid(req) ||
        cancels.size >= maxStreams ||
        req.headers.upgrade?.toLowerCase() !== "websocket"
      ) {
        socket.destroy();
        return;
      }
      forwardUpgrade(req, socket, head, target, track);
    });
    browser.on("connect", (_req, socket) => socket.destroy());
    browser.on("clientError", (_error, socket) => socket.destroy());
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
