import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import type { Socket } from "node:net";
import { z } from "zod";
import { PreviewPort } from "@ace/protocol/preview";
import { createPreviewAuth, type DeviceAuthority } from "./auth.ts";
import { cookieValue, httpCookieName, httpsCookieName } from "./headers.ts";
import { forwardHttp, forwardUpgrade, type Track } from "./forward.ts";

const Hostname = z
  .string()
  .min(1)
  .max(180)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
export type GatewayOptions = {
  host: string;
  wildcardHost: string;
  authority: DeviceAuthority;
  port?: number;
  tls?: Pick<ServerOptions, "key" | "cert">;
  limits?: { connections?: number; registrations?: number; links?: number };
  now?: () => number;
};
type Registration = {
  port: number;
  host: string;
  origin: string;
  active: Map<() => void, { device: string; bufferedBytes: () => number }>;
};

export async function createPreviewGateway(options: GatewayOptions) {
  const wildcardHost = Hostname.parse(options.wildcardHost);
  const maxConnections = z
    .number()
    .int()
    .min(1)
    .max(4096)
    .parse(options.limits?.connections ?? 512);
  const maxRegistrations = z
    .number()
    .int()
    .min(1)
    .max(256)
    .parse(options.limits?.registrations ?? 64);
  const maxLinks = z
    .number()
    .int()
    .min(1)
    .max(4096)
    .parse(options.limits?.links ?? 512);
  const protocol = options.tls ? "https" : "http";
  const cookieName = options.tls ? httpsCookieName : httpCookieName;
  const auth = createPreviewAuth({
    secret: randomBytes(32),
    now: options.now ?? Date.now,
    nonce: () => randomBytes(16).toString("hex"),
    authority: options.authority,
    maxLinks,
  });
  const byPort = new Map<number, Registration>();
  const byHost = new Map<string, Registration>();
  const sockets = new Set<Socket>();
  let closed = false;
  let activeRequests = 0;
  let revocationGeneration = 0;
  const server = options.tls
    ? createHttpsServer({ ...options.tls, maxHeaderSize: 16_384 })
    : createHttpServer({ maxHeaderSize: 16_384 });
  server.maxConnections = maxConnections;
  server.maxHeadersCount = 100;
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const lookup = (req: IncomingMessage) => {
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.method === "CONNECT") return;
    const entry = byHost.get(req.headers.host?.toLowerCase() ?? "");
    if (!entry || (req.headers.origin && req.headers.origin !== entry.origin)) return;
    return entry;
  };
  const trackFor =
    (entry: Registration, device: string): Track =>
    (cancel, bufferedBytes) => {
      entry.active.set(cancel, { device, bufferedBytes });
      return () => entry.active.delete(cancel);
    };
  const valid = (entry: Registration) => !closed && byPort.get(entry.port) === entry;
  server.on("request", (req, res) => {
    if (activeRequests >= maxConnections) {
      res.writeHead(503);
      res.end();
      return;
    }
    activeRequests++;
    res.once("close", () => {
      activeRequests--;
    });
    const generation = revocationGeneration;
    void (async () => {
      const entry = lookup(req);
      if (!entry) {
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", entry.origin);
      if (url.pathname === "/.ace-preview/login") {
        const session =
          req.method === "GET"
            ? await auth.redeem(url.searchParams.get("token") ?? "", entry.host)
            : undefined;
        if (!session || !valid(entry) || generation !== revocationGeneration) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(303, {
          location: "/",
          "set-cookie": `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${options.tls ? "; Secure" : ""}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end();
        return;
      }
      const device = await auth.authenticate(
        cookieValue(req.headers.cookie, cookieName),
        entry.host,
      );
      if (!device || !valid(entry) || generation !== revocationGeneration) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (!res.destroyed) forwardHttp(req, res, entry, trackFor(entry, device));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(403);
      res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    socket.pause();
    if (activeRequests >= maxConnections) {
      socket.destroy();
      return;
    }
    activeRequests++;
    socket.once("close", () => {
      activeRequests--;
    });
    const generation = revocationGeneration;
    void (async () => {
      const entry = lookup(req);
      if (!entry || req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      const device = await auth.authenticate(
        cookieValue(req.headers.cookie, cookieName),
        entry.host,
      );
      if (!device || !valid(entry) || generation !== revocationGeneration) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!socket.destroyed) forwardUpgrade(req, socket, head, entry, trackFor(entry, device));
    })().catch(() => socket.destroy());
  });
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Preview listener has no TCP address");
  const authorityPort = address.port;
  const unregister = (port: number) => {
    const entry = byPort.get(port);
    if (!entry) return;
    byPort.delete(port);
    byHost.delete(entry.host);
    for (const cancel of entry.active.keys()) cancel();
    entry.active.clear();
  };
  return {
    port: authorityPort,
    register(input: { port: number }) {
      if (closed) throw new Error("Preview gateway closed");
      const port = PreviewPort.parse(input.port);
      const existing = byPort.get(port);
      if (existing) return existing.origin;
      if (byPort.size >= maxRegistrations) throw new Error("Too many previews");
      const previewUrl = new URL(
        `${protocol}://p${port}-${randomBytes(8).toString("hex")}.${wildcardHost}:${authorityPort}`,
      );
      const host = previewUrl.host;
      const entry: Registration = {
        port,
        host,
        origin: previewUrl.origin,
        active: new Map(),
      };
      byPort.set(port, entry);
      byHost.set(host, entry);
      return entry.origin;
    },
    unregister,
    async mintLink(input: { port: number; deviceToken: string }) {
      const entry = byPort.get(PreviewPort.parse(input.port));
      if (!entry || closed) throw new Error("Preview is not registered");
      const generation = revocationGeneration;
      const token = await auth.mint(entry.host, input.deviceToken);
      if (!valid(entry) || generation !== revocationGeneration)
        throw new Error("Preview is no longer registered");
      return `${entry.origin}/.ace-preview/login?token=${encodeURIComponent(token)}`;
    },
    revokeDevice(deviceId: string) {
      revocationGeneration++;
      for (const entry of byPort.values())
        for (const [cancel, device] of entry.active) if (device.device === deviceId) cancel();
    },
    stats() {
      let bufferedBytes = 0;
      for (const entry of byPort.values())
        for (const work of entry.active.values()) bufferedBytes += work.bufferedBytes();
      return {
        connections: sockets.size,
        requests: activeRequests,
        registrations: byPort.size,
        bufferedBytes,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const port of byPort.keys()) unregister(port);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
