import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { Socket } from "node:net";
import { createServer as createTlsServer, type TlsOptions } from "node:tls";
import { bindListener } from "./listener.ts";

export interface SniLimits {
  /** A client must finish the TLS handshake within this many milliseconds. */
  handshake: number;
  /** ...then send its first request's headers within this. */
  headers: number;
  /** A connection with no request in flight is closed after this. */
  keepAlive: number;
}

const defaultLimits: SniLimits = { handshake: 10_000, headers: 10_000, keepAlive: 5_000 };

export interface SniListenerOptions {
  /** TLS options, including the `SNICallback` that picks a certificate per server name. */
  tls: TlsOptions;
  requests: RequestListener;
  delay(callback: () => void, milliseconds: number): () => void;
  /** Errors the listener hits after it is bound, such as running out of file descriptors. */
  log(error: Error): void;
  limits?: Partial<SniLimits>;
}

export interface SniListener {
  /** Where requests and WebSocket upgrades arrive, as they would on an `https.Server`. */
  readonly http: Server;
  /** Binds the listener and settles with the port it got. */
  listen(host: string, port: number): Promise<number>;
  /**
   * Stops accepting connections and drops every HTTP one. Upgraded sockets belong to their
   * WebSocket server, which closes them with a close code.
   */
  close(): Promise<void>;
}

interface Connection {
  /** The TCP socket under it: the same object on Bun, its parent on Node. */
  raw: Socket;
  inflight: number;
  cancel?: () => void;
}

/** Identifies a TCP connection, so the TLS socket on top can be matched to its raw socket. */
const peer = (socket: Socket) =>
  `${socket.localAddress}:${socket.localPort}|${socket.remoteAddress}:${socket.remotePort}`;

/**
 * An HTTPS listener whose certificate is chosen per connection by `tls.SNICallback`. A `node:tls`
 * server ends TLS and hands each decrypted socket to a plain HTTP server, because Bun's
 * `node:https` ignores `SNICallback` while its `node:tls` honours it (ADR 0003). That HTTP server
 * never listens, so its own timeouts never run; the limits here bound every socket instead.
 */
export function sniListener(options: SniListenerOptions): SniListener {
  const limits = { ...defaultLimits, ...options.limits };
  const http = createHttpServer(options.requests);
  const front = createTlsServer({
    ALPNProtocols: ["http/1.1"],
    handshakeTimeout: limits.handshake,
    ...options.tls,
  });
  const owned = new Set<Socket>();
  const handshaking = new Map<string, Socket>();
  const connections = new Map<Socket, Connection>();
  const own = (socket: Socket) => {
    owned.add(socket);
    socket.once("close", () => owned.delete(socket));
  };
  const expire = (socket: Socket, connection: Connection, milliseconds: number) => {
    connection.cancel?.();
    connection.cancel = options.delay(() => socket.destroy(), milliseconds);
  };
  const hold = (connection: Connection) => {
    connection.cancel?.();
    connection.cancel = undefined;
  };

  front.on("connection", (raw: Socket) => {
    own(raw);
    const key = peer(raw);
    handshaking.set(key, raw);
    raw.once("close", () => {
      if (handshaking.get(key) === raw) handshaking.delete(key);
    });
  });
  // Node reports a stalled or failed handshake here and leaves the socket open.
  front.on("tlsClientError", (_error, socket) => socket.destroy());
  front.on("secureConnection", (socket: Socket) => {
    const key = peer(socket);
    const connection: Connection = { raw: handshaking.get(key) ?? socket, inflight: 0 };
    handshaking.delete(key);
    own(socket);
    connections.set(socket, connection);
    socket.once("close", () => {
      hold(connection);
      connections.delete(socket);
    });
    expire(socket, connection, limits.headers);
    http.emit("connection", socket);
  });
  http.on("request", (request, response) => {
    const socket = request.socket;
    const connection = connections.get(socket);
    if (!connection) return;
    connection.inflight++;
    hold(connection);
    response.once("close", () => {
      connection.inflight--;
      if (connection.inflight === 0 && !socket.destroyed)
        expire(socket, connection, limits.keepAlive);
    });
  });
  // An upgraded socket leaves HTTP: its WebSocket server bounds and closes it from here on.
  http.on("upgrade", (request) => {
    const socket = request.socket;
    const connection = connections.get(socket);
    if (!connection) return;
    hold(connection);
    connections.delete(socket);
    owned.delete(socket);
    owned.delete(connection.raw);
  });

  let bound = false;
  return {
    http,
    async listen(host, port) {
      const bind = await bindListener(front, host, port);
      if (!bound) front.on("error", (error) => options.log(error));
      bound = true;
      return bind;
    },
    close() {
      front.close();
      const sockets = [...owned];
      const closed = sockets.map(
        (socket) => new Promise((resolve) => socket.once("close", resolve)),
      );
      for (const socket of sockets) socket.destroy();
      return Promise.all(closed).then(() => undefined);
    },
  };
}
