import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { peerOf } from "./http-peer.ts";
import type { PreAuthAdmission } from "./socket-admission.ts";

const refuseUpgrade = (socket: Duplex, status: string) =>
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );

/**
 * The daemon's own address on its loopback listener (`http://127.0.0.1:<port>`, `localhost`
 * or `[::1]`): the origin of the web app it serves itself. Only literal loopback names count,
 * so a rebound DNS name pointing here is still refused. The port is the listener's public one:
 * with the native transport that is its own port, never the internal server's.
 */
export function ownLoopbackOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port) === port
    );
  } catch {
    return false;
  }
}

/** What to do with an arriving WebSocket upgrade. */
export type UpgradeDecision = "accept" | "forbidden" | "unavailable" | "drop";

/**
 * The upgrade admission rules, in order: only `/`, an allowed Origin on loopback (or, when the
 * daemon serves the web app, its own loopback origin), then the connection and
 * pre-authentication budgets.
 */
export function upgradeDecision(input: {
  url: string | undefined;
  origin: string | undefined;
  isLocal: boolean;
  address: string;
  servesRenderer: boolean;
  ownOrigin(origin: string): boolean;
  allowedOrigins: ReadonlySet<string>;
  full(): boolean;
  preAuth: PreAuthAdmission;
}): UpgradeDecision {
  if (input.url !== "/") return "drop";
  // Loopback shares the HTTP access allowlist. Remote clients authenticate
  // with paired-device tickets, including native clients with URL-derived Origin.
  if (
    input.isLocal &&
    input.origin !== undefined &&
    !input.allowedOrigins.has(input.origin) &&
    !(input.servesRenderer && input.ownOrigin(input.origin))
  ) {
    return "forbidden";
  }
  const kind: "local" | "remote" = input.isLocal ? "local" : "remote";
  if (input.full() || !input.preAuth.admits(kind, input.address)) return "unavailable";
  return "accept";
}

/**
 * Admit WebSocket upgrades on `listener`: only `/`, an allowed Origin on loopback (or, when the
 * daemon serves the web app, its own loopback origin), and within the connection and
 * pre-authentication budgets. Admitted sockets reach `connection`.
 */
export function admitUpgrades(
  listener: Server,
  isLocal: boolean,
  options: {
    wss: WebSocketServer;
    allowedOrigins: ReadonlySet<string>;
    /** The listener serves the web app (`webRoot`): its page may open the socket. */
    servesRenderer?: boolean;
    preAuth: PreAuthAdmission;
    full(): boolean;
    remoteSockets: Set<WebSocket>;
  },
): Server {
  const { wss, preAuth, remoteSockets } = options;
  return listener.on("upgrade", (request, socket, head) => {
    const address = peerOf(request).address;
    const kind: "local" | "remote" = isLocal ? "local" : "remote";
    const decision = upgradeDecision({
      url: request.url,
      origin: request.headers.origin,
      isLocal,
      address,
      servesRenderer: options.servesRenderer === true,
      ownOrigin: (origin) => {
        const bound = listener.address();
        return bound !== null && typeof bound !== "string" && ownLoopbackOrigin(origin, bound.port);
      },
      allowedOrigins: options.allowedOrigins,
      full: options.full,
      preAuth,
    });
    if (decision === "drop") {
      socket.destroy();
      return;
    }
    if (decision === "forbidden") {
      refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    if (decision === "unavailable") {
      refuseUpgrade(socket, "503 Service Unavailable");
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      if (!isLocal) {
        remoteSockets.add(websocket);
        websocket.once("close", () => remoteSockets.delete(websocket));
      }
      preAuth.track(websocket, kind, address);
      wss.emit("connection", websocket, isLocal, request);
    });
  });
}
