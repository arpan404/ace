import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { Socket } from "node:net";
import { createServer as createTlsServer, type TlsOptions } from "node:tls";
import { bindListener } from "./listener.ts";

export interface SniListener {
  /** Where requests and WebSocket upgrades arrive, as they would on an `https.Server`. */
  readonly http: Server;
  /** Binds the listener and settles with the port it got. */
  listen(host: string, port: number): Promise<number>;
  /** Stops accepting connections and drops every open one. */
  close(): Promise<void>;
}

/**
 * An HTTPS listener whose certificate is chosen per connection by `tls.SNICallback`. A `node:tls`
 * server ends TLS and hands each decrypted socket to a plain HTTP server, because Bun's
 * `node:https` ignores `SNICallback` while its `node:tls` honours it (ADR 0003).
 */
export function sniListener(tls: TlsOptions, requests: RequestListener): SniListener {
  const http = createHttpServer(requests);
  const front = createTlsServer({ ALPNProtocols: ["http/1.1"], ...tls });
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  // Raw sockets too, so a client stalled mid-handshake can't hold `close` open.
  front.on("connection", track);
  front.on("secureConnection", (socket) => {
    track(socket);
    http.emit("connection", socket);
  });
  return {
    http,
    listen: (host, port) => bindListener(front, host, port),
    close: () =>
      new Promise<void>((resolve) => {
        front.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
