import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { hostId } from "@ace/secure-channel";
import type { Transport } from "@ace/secure-channel";
import { FrameReader, sendFrame } from "./socket.ts";
import { handshake, CONTROL_PROLOGUE } from "./handshake.ts";
import { defaultLimits, IpLimits } from "./limits.ts";
import type { Limits } from "./limits.ts";
type Host = { socket: WebSocket; transport: Transport };
type Ticket = { client: WebSocket; host: Host; expires: number };
export type RelayOptions = {
  port?: number;
  bind?: string;
  limits?: Partial<Limits>;
  now?: () => number;
  onBackpressure?: (bufferedBytes: number) => void;
};
/** No application payload is decrypted, parsed, or logged by this server. */
export async function startRelay(options: RelayOptions = {}) {
  const limits = { ...defaultLimits, ...options.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid relay limit");
  if (limits.maxFrameSize > 65535 || limits.highWaterBytes > limits.maxBufferedBytes)
    throw new Error("Invalid relay buffer limits");
  const now = options.now ?? (() => performance.now());
  const ipLimits = new IpLimits(limits, now);
  const hosts = new Map<string, Host>();
  const tickets = new Map<string, Ticket>();
  const activity = new Map<WebSocket, number>();
  const stats = { peakBufferedBytes: 0, pausedReaders: 0, forwardedFrames: 0 };
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxFrameSize,
    perMessageDeflate: false,
    autoPong: false,
    maxFragments: 256,
    maxBufferedChunks: 256,
  });
  http.on("upgrade", (request, socket, head) => {
    const ip = request.socket.remoteAddress ?? "unknown";
    if (wss.clients.size >= limits.maxConnections || !ipLimits.acquire(ip)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) ipLimits.release(ip);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      activity.set(ws, now());
      ws.on("error", () => {
        /* Payloads and protocol errors are intentionally not logged. */
      });
      ws.on("pong", () => {
        if (!ipLimits.message(ip)) ws.close(1008, "Rate limit");
        else activity.set(ws, now());
      });
      ws.on("ping", (data) => {
        if (!ipLimits.message(ip)) ws.close(1008, "Rate limit");
        else if (ws.bufferedAmount + data.length > limits.maxBufferedBytes) ws.terminate();
        else {
          activity.set(ws, now());
          ws.pong(data);
        }
      });
      ws.on("message", (_data, binary) => {
        activity.set(ws, now());
        if (!binary) ws.close(1003, "Binary required");
        else if (!ipLimits.message(ip)) ws.close(1008, "Rate limit");
      });
      ws.once("close", () => {
        ipLimits.release(ip);
        activity.delete(ws);
      });
      void route(ws, new URL(request.url ?? "/", "http://relay")).catch(() => ws.terminate());
    });
  });
  const forward = (source: WebSocket, destination: WebSocket) => {
    source.on("message", (data, binary) => {
      if (!binary || source.readyState !== WebSocket.OPEN) return;
      if (destination.readyState !== WebSocket.OPEN) {
        source.terminate();
        return;
      }
      const size = Array.isArray(data)
        ? data.reduce((n, p) => n + p.length, 0)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : data.length;
      if (destination.bufferedAmount + size > limits.maxBufferedBytes) {
        source.terminate();
        destination.terminate();
        return;
      }
      destination.send(data, { binary: true }, (error) => {
        if (error) {
          source.terminate();
          destination.terminate();
        } else if (destination.bufferedAmount < limits.highWaterBytes / 2) source.resume();
      });
      stats.forwardedFrames++;
      stats.peakBufferedBytes = Math.max(stats.peakBufferedBytes, destination.bufferedAmount);
      if (destination.bufferedAmount >= limits.highWaterBytes) {
        source.pause();
        stats.pausedReaders++;
        options.onBackpressure?.(destination.bufferedAmount);
      }
    });
    source.once("close", () => destination.terminate());
  };
  function pair(client: WebSocket, host: WebSocket): void {
    forward(client, host);
    forward(host, client);
    // This relay-level marker contains no daemon data. Client starts Noise only after pairing.
    void sendFrame(client, new Uint8Array([1])).catch(() => client.terminate());
  }
  async function route(socket: WebSocket, url: URL): Promise<void> {
    if (url.pathname === "/host") {
      const reader = new FrameReader(socket);
      const transport = await handshake(socket, reader, {
        initiator: false,
        prologue: CONTROL_PROLOGUE,
      });
      const id = hostId(transport.remoteStatic);
      if (hosts.has(id) || socket.readyState !== WebSocket.OPEN) {
        transport.destroy();
        socket.close(1008, "Host already registered");
        return;
      }
      const host = { socket, transport };
      hosts.set(id, host);
      socket.once("close", () => {
        if (hosts.get(id) === host) hosts.delete(id);
        transport.destroy();
        for (const [ticket, entry] of tickets)
          if (entry.host === host) {
            tickets.delete(ticket);
            entry.client.terminate();
          }
      });
      await sendFrame(
        socket,
        transport.send.encrypt(
          new TextEncoder().encode(JSON.stringify({ type: "registered", hostId: id })),
        ),
      );
      // Control is server-to-host only after authentication. Unexpected traffic fails closed.
      await reader.next();
      socket.close(1008, "Unexpected control frame");
    } else if (url.pathname === "/client") {
      const host = hosts.get(url.searchParams.get("hostId") ?? "");
      if (!host) {
        socket.close(1008, "Host unavailable");
        return;
      }
      const ticket = randomBytes(32).toString("hex");
      tickets.set(ticket, { client: socket, host, expires: now() + 10000 });
      const premature = () => socket.close(1008, "Stream not paired");
      socket.on("message", premature);
      socket.once("close", () => tickets.delete(ticket));
      // Removed when consumed. No forwarding occurs before the authenticated host joins.
      pendingListeners.set(socket, premature);
      if (host.socket.bufferedAmount > limits.highWaterBytes) {
        tickets.delete(ticket);
        socket.close(1013, "Host busy");
        return;
      }
      await sendFrame(
        host.socket,
        host.transport.send.encrypt(
          new TextEncoder().encode(JSON.stringify({ type: "client", ticket })),
        ),
      );
    } else if (url.pathname === "/join") {
      const ticket = url.searchParams.get("ticket") ?? "";
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (
        !entry ||
        entry.expires <= now() ||
        entry.client.readyState !== WebSocket.OPEN ||
        entry.host.socket.readyState !== WebSocket.OPEN
      ) {
        entry?.client.terminate();
        socket.close(1008, "Invalid ticket");
        return;
      }
      const listener = pendingListeners.get(entry.client);
      if (listener) entry.client.removeListener("message", listener);
      pendingListeners.delete(entry.client);
      pair(entry.client, socket);
    } else socket.close(1008, "Unknown endpoint");
  }
  const pendingListeners = new WeakMap<WebSocket, () => void>();
  function sweep(): void {
    for (const [ticket, entry] of tickets)
      if (entry.expires <= now()) {
        tickets.delete(ticket);
        entry.client.terminate();
      }
    for (const [socket, last] of activity)
      if (now() - last >= limits.idleTimeoutMs) socket.terminate();
    ipLimits.sweep();
  }
  const timer = setInterval(
    () => {
      sweep();
      for (const socket of wss.clients) socket.ping();
    },
    Math.min(10000, limits.idleTimeoutMs / 2),
  );
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.bind ?? "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No relay address");
  return {
    url: `ws://${options.bind ?? "127.0.0.1"}:${address.port}`,
    port: address.port,
    stats,
    /** Advances idle cleanup using the injected clock, without wall-clock sleeps in tests. */
    sweep,
    async close(): Promise<void> {
      clearInterval(timer);
      for (const socket of wss.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}
