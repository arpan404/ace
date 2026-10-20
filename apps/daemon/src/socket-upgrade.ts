import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import type { PreAuthAdmission } from "./socket-admission.ts";

const refuseUpgrade = (socket: Duplex, status: string) =>
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
    socket.destroy(),
  );

/**
 * The daemon's own address on this loopback listener (`http://127.0.0.1:<port>`, `localhost`
 * or `[::1]`): the origin of the web app it serves itself. Only literal loopback names count,
 * so a rebound DNS name pointing here is still refused.
 */
function ownLoopbackOrigin(origin: string, listener: Server): boolean {
  const address = listener.address();
  if (!address || typeof address === "string") return false;
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port) === address.port
    );
  } catch {
    return false;
  }
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
    if (request.url !== "/") {
      socket.destroy();
      return;
    }
    // Loopback shares the HTTP access allowlist. Remote clients authenticate
    // with paired-device tickets, including native clients with URL-derived Origin.
    const origin = request.headers.origin;
    if (
      isLocal &&
      origin !== undefined &&
      !options.allowedOrigins.has(origin) &&
      !(options.servesRenderer && ownLoopbackOrigin(origin, listener))
    ) {
      refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    const kind: "local" | "remote" = isLocal ? "local" : "remote";
    const address = request.socket.remoteAddress ?? "unknown";
    if (options.full() || !preAuth.admits(kind, address)) {
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
