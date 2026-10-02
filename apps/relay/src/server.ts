import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { hostId } from "@ace/secure-channel";
import type { Transport } from "@ace/secure-channel";
import { z } from "zod";
import { FrameReader, sendFrame } from "./socket.ts";
import { respondHandshake, CONTROL_PROLOGUE } from "./handshake.ts";
import { LimitsSchema, HostControlMessage } from "./config.ts";
import type { Limits } from "./config.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { IpBudget } from "./limits.ts";
import { Throttle } from "./throttle.ts";
import { RelayRoutes } from "./routes.ts";
import type { RouteAction } from "./routes.ts";
import { pairStreams } from "./forward.ts";
import type { RelayStats } from "./forward.ts";
const noop = () => {};
export type RelayOptions = {
  port?: number;
  bind?: string;
  limits?: Partial<Limits>;
  allowedHostIds?: readonly string[];
  clock?: Clock;
  now?: () => number;
  createTicket?: () => string;
  createConnectionId?: () => string;
  onBackpressure?: (bytes: number) => void;
  onThrottle?: () => void;
};
type Connection = {
  socket: WebSocket;
  reader: FrameReader;
  abort: AbortController;
  lastActivity: number;
  control?: Transport;
};
/** Thin socket shell: registration proof, actions, forwarding and owned deadlines. */
export async function startRelay(options: RelayOptions = {}) {
  const limits = LimitsSchema.parse(options.limits ?? {});
  const clock = options.clock ?? systemClock(options.now);
  const routing = new RelayRoutes({
    ticketTimeoutMs: limits.ticketTimeoutMs,
    ...(options.allowedHostIds ? { allowedHostIds: options.allowedHostIds } : {}),
  });
  const budget = new IpBudget(limits);
  const stats: RelayStats = {
    peakBufferedBytes: 0,
    pausedReaders: 0,
    forwardedFrames: 0,
    throttledFrames: 0,
    peakReaderBytes: 0,
  };
  const throttle = new Throttle(clock, () => {
    stats.throttledFrames++;
    options.onThrottle?.();
  });
  const connections = new Map<string, Connection>();
  const createTicket = options.createTicket ?? (() => randomBytes(32).toString("hex"));
  const createId = options.createConnectionId ?? randomUUID;
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
  async function apply(actions: RouteAction[]): Promise<void> {
    for (const action of actions) {
      if (action.type === "pair") {
        const client = connections.get(action.client),
          host = connections.get(action.host);
        if (client && host) pairStreams(client, host, limits, stats, options.onBackpressure);
        else {
          client?.socket.terminate();
          host?.socket.terminate();
        }
        continue;
      }
      const connection = connections.get(action.socket);
      if (!connection) continue;
      if (action.type === "close") {
        connection.socket.close(action.code, action.reason);
        if (action.code === 4001) connection.socket.terminate();
        continue;
      }
      if (!connection.control) throw new Error("Control session missing");
      if (connection.socket.bufferedAmount > limits.highWaterBytes) {
        connection.socket.terminate();
        continue;
      }
      await sendFrame(
        connection.socket,
        connection.control.send.encrypt(
          new TextEncoder().encode(
            JSON.stringify(
              action.type === "registered"
                ? { type: "registered", hostId: action.hostId }
                : { type: "client", ticket: action.ticket },
            ),
          ),
        ),
      );
    }
  }
  async function route(id: string, url: URL, connection: Connection): Promise<void> {
    if (url.pathname === "/host") {
      const control = await respondHandshake(connection.socket, connection.reader, {
        prologue: CONTROL_PROLOGUE,
        clock,
        timeoutMs: limits.handshakeTimeoutMs,
      });
      connection.control = control;
      if (connection.socket.readyState !== WebSocket.OPEN) {
        control.destroy();
        return;
      }
      await apply(routing.register(id, hostId(control.remoteStatic)));
      while (connection.socket.readyState === WebSocket.OPEN) {
        const input: unknown = JSON.parse(
          new TextDecoder().decode(control.receive.decrypt(await connection.reader.next())),
        );
        const message = HostControlMessage.parse(input);
        await apply(routing.reject(id, message.ticket));
      }
    } else if (url.pathname === "/client")
      await apply(
        routing.request(id, url.searchParams.get("hostId") ?? "", createTicket(), clock.now()),
      );
    else if (url.pathname === "/join")
      await apply(routing.join(id, url.searchParams.get("ticket") ?? "", clock.now()));
    else connection.socket.close(1008, "Unknown endpoint");
  }
  http.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://relay");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    const ip = request.socket.remoteAddress ?? "";
    if (!ip) {
      socket.destroy();
      return;
    }
    const peerBudget = budget.forPeer(ip);
    if (wss.clients.size >= limits.maxConnections || !peerBudget.acquire(clock.now())) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) peerBudget.release(clock.now());
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      const id = z.string().min(1).parse(createId());
      if (connections.has(id)) {
        ws.terminate();
        peerBudget.release(clock.now());
        return;
      }
      const abort = new AbortController();
      const connection: Connection = {
        socket: ws,
        abort,
        lastActivity: clock.now(),
        reader: new FrameReader(ws, {
          permit: () => throttle.wait(peerBudget, abort.signal),
          onFrame: () => {
            connection.lastActivity = clock.now();
            void apply(routing.premature(id)).catch(() => ws.terminate());
          },
        }),
      };
      connections.set(id, connection);
      ws.on("error", () => {});
      let controlQueue: Promise<void> = Promise.resolve();
      let controls = 0;
      function acceptControl(data: Buffer, reply: () => void): void {
        if (++controls > 256) {
          ws.terminate();
          return;
        }
        controlQueue = controlQueue
          .then(async () => {
            const release = connection.reader.hold();
            try {
              await throttle.wait(peerBudget, abort.signal);
              connection.lastActivity = clock.now();
              if (ws.bufferedAmount + data.length + 2 > limits.maxBufferedBytes) ws.terminate();
              else reply();
            } finally {
              controls--;
              release();
            }
          })
          .catch(() => ws.terminate());
      }
      ws.on("ping", (data) => acceptControl(data, () => ws.pong(data)));
      ws.on("pong", (data) => acceptControl(data, () => {}));
      ws.once("close", () => {
        abort.abort();
        connection.control?.destroy();
        connections.delete(id);
        peerBudget.release(clock.now());
        void apply(routing.close(id)).catch(() => {});
      });
      void route(id, url, connection).catch(() => ws.terminate());
    });
  });
  function sweep(): void {
    void apply(routing.sweep(clock.now())).catch(() => {});
    for (const connection of connections.values())
      if (clock.now() - connection.lastActivity >= limits.idleTimeoutMs)
        connection.socket.terminate();
    budget.sweep(clock.now());
  }
  let cancelled = false;
  let cancelSweep: () => void = noop;
  function probe(): void {
    if (cancelled) return;
    sweep();
    for (const connection of connections.values())
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
    cancelSweep = clock.schedule(Math.min(10000, limits.idleTimeoutMs / 2), probe);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 0, options.bind ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    throttle.close();
    throw error;
  }
  cancelSweep = clock.schedule(Math.min(10000, limits.idleTimeoutMs / 2), probe);
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No relay address");
  let closing: Promise<void> | undefined;
  return {
    url: `ws://${options.bind ?? "127.0.0.1"}:${address.port}`,
    port: address.port,
    stats,
    sweep,
    close(): Promise<void> {
      if (closing) return closing;
      cancelled = true;
      cancelSweep();
      throttle.close();
      for (const connection of connections.values()) connection.socket.terminate();
      closing = Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        ),
      ]).then(() => {});
      return closing;
    },
  };
}
