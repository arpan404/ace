import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { createApnsClient, ApnsToken, type ApnsClient } from "@ace/notify/apns-client";
import { IpBudget } from "@ace/relay";
import { daemonIdentity } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { openHandle, sealHandle } from "./handles.ts";
import { GoneTokens, HourlyLimit } from "./limits.ts";
import { alertPush, maxBody } from "./payload.ts";

export interface GatewayRuntime {
  now(): number;
  random(size: number): Buffer;
  /** One line per request: route and status only. Never tokens, handles, keys, IPs or bodies. */
  log(entry: { route: string; status: number; reason?: string }): void;
  apns?: ApnsClient;
}
export interface Gateway {
  port: number;
  close(): Promise<void>;
}
const RegistrationBody = z.object({
  token: ApnsToken,
  environment: z.enum(["sandbox", "production"]),
});
const goneReasons = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const ipKeys = new IpBudget();

export const systemRuntime = (): GatewayRuntime => ({
  now: Date.now,
  random: randomBytes,
  log: (entry) => console.log(JSON.stringify(entry)),
});

/** The push gateway (ADR 0106): authenticated daemons push encrypted alerts to phones via APNs. */
export async function startGateway(
  config: GatewayConfig,
  runtime: GatewayRuntime = systemRuntime(),
): Promise<Gateway> {
  const apns =
    runtime.apns ??
    createApnsClient(
      {
        teamId: config.apns.teamId,
        keyId: config.apns.keyId,
        privateKey: config.apns.privateKey,
        origins: config.apns.origins,
        maxConcurrent: config.limits.maxConcurrent,
      },
      runtime.now,
    );
  const { limits } = config;
  const perIp = new HourlyLimit(limits.perIp, limits.maxEntries);
  const registrations = new HourlyLimit(limits.registrationsPerDaemon, limits.maxEntries);
  const pushes = new HourlyLimit(limits.pushesPerDaemon, limits.maxEntries);
  const perHandle = new HourlyLimit(limits.pushesPerHandle, limits.maxEntries);
  const gone = new GoneTokens(limits.maxEntries);

  const clientKey = (request: IncomingMessage) => {
    const forwarded = config.trustProxy ? request.headers["x-forwarded-for"] : undefined;
    const value = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : undefined;
    try {
      return ipKeys.forPeer(value || request.socket.remoteAddress || "").key;
    } catch {
      return "unknown";
    }
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (route: string, status: number, body?: object, headers: object = {}) => {
      runtime.log({ route, status });
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body ? JSON.stringify(body) : "");
    };
    const url = new URL(request.url ?? "/", "http://gateway");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    const pushMatch = /^\/v1\/push\/([A-Za-z0-9_-]{1,1024})$/.exec(url.pathname);
    const route = url.pathname === "/v1/registrations" ? "register" : pushMatch ? "push" : "";
    if (!route || request.method !== "POST") return reply("unknown", 404);
    const now = runtime.now();
    const ipWait = perIp.take(clientKey(request), now);
    if (ipWait) return reply(route, 429, undefined, retryAfter(ipWait));
    const daemon = daemonIdentity(request.headers.authorization, config.publicOrigin, now);
    if (!daemon) return reply(route, 401);
    const body = await readBody(request, route === "register" ? 1024 : maxBody);
    if (!body) return reply(route, 413);
    if (route === "register") {
      const wait = registrations.take(daemon, now);
      if (wait) return reply(route, 429, undefined, retryAfter(wait));
      const parsed = RegistrationBody.safeParse(safeJson(body));
      if (!parsed.success) return reply(route, 400);
      if (gone.has(tokenHash(parsed.data.token), now)) return reply(route, 410);
      const expiresAt = now + config.handleLifetimeMs;
      const key = config.sealKeys[0];
      if (!key) return reply(route, 500);
      const sealed = sealHandle(
        key,
        { token: parsed.data.token, environment: parsed.data.environment, daemon, expiresAt },
        runtime.random(12),
      );
      return reply(route, 201, { handle: sealed, expiresAt });
    }
    const registration = openHandle(config.sealKeys, pushMatch?.[1] ?? "");
    if (!registration || registration.expiresAt <= now) return reply(route, 404);
    if (registration.daemon !== daemon) return reply(route, 403);
    const hash = tokenHash(registration.token);
    if (gone.has(hash, now)) return reply(route, 410);
    const push = alertPush(request.headers, body, now);
    if (push === "size") return reply(route, 413);
    if (typeof push === "string") return reply(route, 400);
    const wait = Math.max(pushes.take(daemon, now), perHandle.take(hash, now));
    if (wait) return reply(route, 429, undefined, retryAfter(wait));
    const result = await apns.send(
      {
        environment: registration.environment,
        token: registration.token,
        topic: config.apns.topic,
        pushType: "alert",
        ...push,
      },
      AbortSignal.timeout(10_000),
    );
    if (result.status === 200) return reply(route, 201);
    if (result.status === 410 || (result.status === 400 && goneReasons.has(result.reason ?? ""))) {
      gone.add(hash, runtime.now());
      return reply(route, 410);
    }
    if (result.status === 429) return reply(route, 429, undefined, { "retry-after": "60" });
    if (result.status === 0) return reply(route, 503);
    if (result.status === 400 || result.status === 413) return reply(route, 400);
    // Provider token refused (403) or APNs errors: ours to fix, the sender may retry.
    return reply(route, 502);
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.maxHeadersCount = 64;
  server.listen(config.port, config.bind);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway has no port");
  return {
    port: address.port,
    async close() {
      apns.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function tokenHash(token: string): string {
  return createHash("sha256").update(token.toLowerCase()).digest("base64url");
}
function retryAfter(ms: number) {
  return { "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) };
}
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > limit) {
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}
