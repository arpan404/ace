import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { hostId } from "@ace/secure-channel";
import type { Transport } from "@ace/secure-channel";
import { z } from "zod";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { FrameReader, sendFrame } from "./socket.ts";
import { respondHandshake, CONTROL_PROLOGUE } from "./handshake.ts";
import { LimitsSchema, HostControlMessage } from "./config.ts";
import type { Limits } from "./config.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { IpBudget, type PeerBudget } from "./limits.ts";
import { Throttle } from "./throttle.ts";
import { RelayRoutes } from "./routes.ts";
import type { RouteAction } from "./routes.ts";
import { pairStreams } from "./forward.ts";
import { EARLY_FRAME, UPGRADE_MESSAGE, upgradeMessage } from "./early-frame.ts";
import { PAIRED_MARKER } from "./wire.ts";
import { MEDIA_FEATURE, clientPurpose, hostFeatures } from "./purpose.ts";
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
  /**
   * Also serve the same relay over TLS on a second listener (`tlsUrl`), with this certificate
   * chain and key in PEM. Production relays terminate TLS in front of the relay; this lets a
   * test reach the relay itself over `wss://`.
   */
  tls?: { cert: string; key: string };
};
type Connection = {
  socket: WebSocket;
  reader: FrameReader;
  abort: AbortController;
  lastActivity: number;
  control?: Transport;
  /** The readiness marker this client gets when paired. */
  marker: number;
  /** A `/client` socket, and whether it was paired. */
  client: boolean;
  paired: boolean;
  /** Its early frame is held: reading it is paused until pairing (ADR 0155). */
  earlyHold?: (() => void) | undefined;
  /** It is being turned away (`turnAway`): closed, and cut at the deadline. */
  cutting?: boolean;
  /** Its first message came in its upgrade request (ADR 0155, step 3). */
  fromUpgrade?: boolean;
};
/**
 * A client the relay closes before it is paired gets this long to finish the close; then its
 * socket is cut, whether or not it answered, so withholding the answer holds nothing.
 */
const UNPAIRED_CLOSE_MS = 1000;
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
  const sockets = new Map<Socket, PeerBudget>();
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
    // A self-hosted relay stays anonymous: an offered grant (ADR 0111) is echoed, never checked,
    // so daemons and clients signed in to an ace account work here too. A client whose early
    // frame has room reserved is answered with the early subprotocol instead (ADR 0155): one
    // subprotocol is echoed, so that answer is the client's permission to send at once.
    handleProtocols: (protocols, request) =>
      upgradeMessages.has(request)
        ? UPGRADE_MESSAGE.subprotocol
        : earlyUpgrades.has(request)
          ? EARLY_FRAME.subprotocol
          : ([...protocols].find((protocol) => protocol.startsWith(GRANT_SUBPROTOCOL_PREFIX)) ??
            (protocols.has(EARLY_FRAME.neutral) ? EARLY_FRAME.neutral : false)),
  });
  /** Upgrades whose early frame has room reserved, until `ws` answers them. */
  const earlyUpgrades = new WeakSet<IncomingMessage>();
  /** Upgrades whose first message came in the request (step 3), taken once room was reserved. */
  const upgradeMessages = new WeakMap<IncomingMessage, Uint8Array>();
  async function apply(actions: RouteAction[]): Promise<void> {
    for (const action of actions) {
      if (action.type === "pair") {
        const client = connections.get(action.client),
          host = connections.get(action.host);
        // A held early frame is still the first frame in the client's reader: pairing forwards
        // it to this host, right after the marker, before anything sent later. Its room is
        // given back once it has left the reader, not before.
        if (client && host) {
          client.paired = true;
          client.earlyHold?.();
          client.earlyHold = undefined;
          const id = action.client;
          if (action.early) void client.reader.whenEmpty().then(() => routing.releaseEarly(id));
          else routing.releaseEarly(id);
          pairStreams(client, host, limits, stats, options.onBackpressure, client.marker);
        } else {
          client?.socket.terminate();
          host?.socket.terminate();
        }
        continue;
      }
      const connection = connections.get(action.socket);
      if (!connection) continue;
      if (action.type === "close") {
        if (connection.client && !connection.paired) {
          turnAway(connection, action.code, action.reason);
          continue;
        }
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
                : {
                    type: "client",
                    ticket: action.ticket,
                    ...(action.purpose ? { purpose: action.purpose } : {}),
                  },
            ),
          ),
        ),
      );
    }
  }
  /**
   * Every way a client is turned away before it is paired ends here (ADR 0155): its queued
   * frames go now, it is read no more, and its socket is cut after a short deadline whatever it
   * does, so withholding the close answer holds nothing. Its early-frame reservation comes back
   * when the socket is gone (`routing.close`).
   */
  function turnAway(connection: Connection, code: number, reason: string): void {
    if (connection.cutting) return;
    connection.cutting = true;
    connection.reader.fail(new Error("Closed by the relay"));
    connection.socket.pause();
    try {
      connection.socket.close(code, reason);
    } catch {
      connection.socket.terminate();
      return;
    }
    const cut = clock.schedule(UNPAIRED_CLOSE_MS, () => connection.socket.terminate());
    connection.socket.once("close", cut);
  }
  async function route(
    id: string,
    url: URL,
    connection: Connection,
    /** The client's first message from its upgrade request, held as its early frame. */
    message?: Uint8Array,
  ): Promise<void> {
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
      await apply(
        routing.register(id, hostId(control.remoteStatic), hostFeatures(url).has(MEDIA_FEATURE)),
      );
      while (connection.socket.readyState === WebSocket.OPEN) {
        const input: unknown = JSON.parse(
          new TextDecoder().decode(control.receive.decrypt(await connection.reader.next())),
        );
        const message = HostControlMessage.parse(input);
        await apply(routing.reject(id, message.ticket));
      }
    } else if (url.pathname === "/client") {
      const purpose = clientPurpose(url);
      if (purpose === "invalid") turnAway(connection, 1008, "Unknown purpose");
      else {
        const actions = routing.request(
          id,
          url.searchParams.get("hostId") ?? "",
          createTicket(),
          clock.now(),
          purpose,
        );
        // The upgrade's first message is the client's early frame, held as one sent at once,
        // before the offer goes out, so no join can pair the client ahead of it.
        if (message) {
          connection.fromUpgrade = true;
          connection.reader.inject(message);
        }
        await apply(actions);
      }
    } else if (url.pathname === "/join")
      await apply(routing.join(id, url.searchParams.get("ticket") ?? "", clock.now()));
    else connection.socket.close(1008, "Unknown endpoint");
  }
  function releaseSocket(socket: Socket): void {
    const peerBudget = sockets.get(socket);
    if (!peerBudget) return;
    sockets.delete(socket);
    peerBudget.release(clock.now());
  }
  const admit = (socket: Socket) => {
    const ip = socket.remoteAddress;
    if (!ip) {
      socket.destroy();
      return;
    }
    const peerBudget = budget.forPeer(ip);
    if (sockets.size >= limits.maxConnections || !peerBudget.acquire(clock.now())) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n", () =>
        socket.destroy(),
      );
      return;
    }
    sockets.set(socket, peerBudget);
    socket.once("end", () => {
      socket.destroy();
      releaseSocket(socket);
    });
    socket.once("close", () => releaseSocket(socket));
  };
  http.on("connection", admit);
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://relay");
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    const admittedBudget = sockets.get(request.socket);
    if (!admittedBudget) {
      socket.destroy();
      return;
    }
    const peerBudget = admittedBudget;
    const id = z.string().min(1).parse(createId());
    // Room for an early frame is reserved before the upgrade is accepted, never after: a client
    // is told it may send early only once the relay can hold what it sends (ADR 0155).
    const offered = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    if (
      url.pathname === "/client" &&
      clientPurpose(url) !== "invalid" &&
      offered.includes(EARLY_FRAME.subprotocol) &&
      !connections.has(id) &&
      routing.reserveEarly(id, url.searchParams.get("hostId") ?? "")
    ) {
      earlyUpgrades.add(request);
      // Only now, with room reserved, is the request's first message read (ADR 0155, step 3).
      const message = upgradeMessage(request.headers["sec-websocket-protocol"] ?? "");
      if (message) upgradeMessages.set(request, message);
      // An upgrade that never completes gives the room back; a waiting client keeps it.
      socket.once("close", () => routing.releaseEarly(id));
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (connections.has(id)) {
        ws.terminate();
        return;
      }
      const abort = new AbortController();
      const connection: Connection = {
        socket: ws,
        abort,
        // A new client asked (`early=1`): its marker also says this relay holds early frames.
        marker:
          url.searchParams.get(EARLY_FRAME.query) === "1"
            ? EARLY_FRAME.capableMarker
            : PAIRED_MARKER,
        lastActivity: clock.now(),
        client: url.pathname === "/client",
        paired: false,
        reader: new FrameReader(ws, {
          permit: () => throttle.wait(peerBudget, abort.signal),
          // A frame the reader refuses (text, over its queue) from a client not yet paired
          // turns it away like any other refusal; anything else closes as before.
          refuse: (code) =>
            connection.client && !connection.paired
              ? turnAway(connection, code, "")
              : ws.close(code),
          onFrame: (bytes) => {
            connection.lastActivity = clock.now();
            // Before pairing, a client may send one frame it reserved room for; any other is
            // dropped on arrival and closes it.
            const before = routing.earlyState(id);
            const actions = routing.early(id, bytes);
            if (actions.length) {
              void apply(actions).catch(() => ws.terminate());
              return false;
            }
            // The early frame is held: read nothing more from this client until it is paired,
            // so no second frame can be buffered for it in the meantime. One that came in the
            // upgrade (step 3) keeps being read instead: a frame it sends before pairing would
            // be its first message again, and closes it at once rather than after the join.
            if (
              before === "reserved" &&
              routing.earlyState(id) === "held" &&
              !connection.fromUpgrade
            )
              connection.earlyHold = connection.reader.hold();
            return true;
          },
        }),
      };
      connections.set(id, connection);
      // The socket library closes on a protocol error it finds itself (a message over the
      // frame size, a bad frame) and then waits for the answer: a client not yet paired is cut
      // at the deadline instead.
      ws.on("error", () => {
        if (!connection.client || connection.paired || connection.cutting) return;
        connection.cutting = true;
        connection.reader.fail(new Error("Socket error"));
        const cut = clock.schedule(UNPAIRED_CLOSE_MS, () => ws.terminate());
        ws.once("close", cut);
      });
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
        releaseSocket(request.socket);
        abort.abort();
        connection.control?.destroy();
        connections.delete(id);
        void apply(routing.close(id)).catch(() => {});
      });
      void route(id, url, connection, upgradeMessages.get(request)).catch(() => ws.terminate());
    });
  };
  http.on("upgrade", upgrade);
  const secure = options.tls ? createSecureServer(options.tls) : undefined;
  secure?.on("secureConnection", admit);
  secure?.on("upgrade", upgrade);
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
    if (secure)
      await new Promise<void>((resolve, reject) => {
        secure.once("error", reject);
        secure.listen(0, options.bind ?? "127.0.0.1", resolve);
      });
  } catch (error) {
    throttle.close();
    throw error;
  }
  cancelSweep = clock.schedule(Math.min(10000, limits.idleTimeoutMs / 2), probe);
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No relay address");
  const secureAddress = secure?.address();
  let closing: Promise<void> | undefined;
  return {
    url: `ws://${options.bind ?? "127.0.0.1"}:${address.port}`,
    /** With `tls`: the TLS listener's port (the certificate decides which host name fits). */
    tlsPort: secureAddress && typeof secureAddress !== "string" ? secureAddress.port : undefined,
    port: address.port,
    stats,
    sweep,
    /**
     * Early frames held for clients not yet paired (ADR 0155): what the routing policy has
     * reserved and counted, and the bytes actually queued in those clients' readers.
     */
    earlyHeld() {
      let queuedBytes = 0;
      for (const [id, connection] of connections)
        if (routing.earlyState(id) !== undefined) queuedBytes += connection.reader.bufferedBytes;
      return { ...routing.earlyHeld(), queuedBytes };
    },
    close(): Promise<void> {
      if (closing) return closing;
      cancelled = true;
      cancelSweep();
      throttle.close();
      for (const connection of connections.values()) connection.socket.terminate();
      for (const socket of sockets.keys()) socket.destroy();
      closing = Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve) => (secure ? secure.close(() => resolve()) : resolve())),
      ]).then(() => {});
      return closing;
    },
  };
}
