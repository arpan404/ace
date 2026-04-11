import Crypto from "node:crypto";
import Http from "node:http";

const DEFAULT_PORT = 9091;
const HOST_TTL_MS = 10 * 60_000;
const CONNECTION_TTL_MS = 30 * 60_000;
const MAX_NAME_LENGTH = 120;
const DEVICE_ICONS = ["iphone", "ipad", "laptop", "desktop", "watch"] as const;
type DeviceIcon = (typeof DEVICE_ICONS)[number];

interface HostRecord {
  readonly hostToken: string;
  wsUrl: string;
  readonly createdAtMs: number;
  updatedAtMs: number;
}

interface DeviceRecord {
  readonly deviceId: string;
  readonly hostToken: string;
  readonly apiKey: string;
  readonly apiKeyHash: string;
  readonly name: string;
  readonly icon: DeviceIcon;
  readonly createdAtMs: number;
  revokedAtMs: number | null;
  lastResolvedAtMs: number | null;
}

interface ConnectionRecord {
  readonly connectionId: string;
  readonly clientSessionId: string;
  readonly hostToken: string;
  readonly deviceId: string;
  connectedAtMs: number;
  touchedAtMs: number;
}

const hostsByToken = new Map<string, HostRecord>();
const devicesById = new Map<string, DeviceRecord>();
const deviceIdByApiKeyHash = new Map<string, string>();
const connectionById = new Map<string, ConnectionRecord>();
const connectionIdsByDeviceId = new Map<string, Set<string>>();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBody(request: Http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(
  response: Http.ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function writeNotFound(response: Http.ServerResponse): void {
  writeJson(response, 404, { error: "Route not found." });
}

function resolvePublicBaseUrl(request: Http.IncomingMessage): string {
  const configured = process.env.RELAY_PUBLIC_URL?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }
  const hostHeader = request.headers.host?.trim();
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0]?.trim();
  const protocol = proto === "https" ? "https" : "http";
  const host = hostHeader && hostHeader.length > 0 ? hostHeader : "localhost";
  return `${protocol}://${host}`;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function isValidDeviceIcon(value: string): value is DeviceIcon {
  return (DEVICE_ICONS as readonly string[]).includes(value);
}

function normalizeDeviceName(name: string | null): string {
  if (!name) {
    return "Remote device";
  }
  return name.slice(0, MAX_NAME_LENGTH);
}

function normalizeWsUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function hashApiKey(apiKey: string): string {
  return Crypto.createHash("sha256").update(apiKey).digest("hex");
}

function ensureConnectionSet(deviceId: string): Set<string> {
  const current = connectionIdsByDeviceId.get(deviceId);
  if (current) {
    return current;
  }
  const next = new Set<string>();
  connectionIdsByDeviceId.set(deviceId, next);
  return next;
}

function removeConnection(connectionId: string): void {
  const connection = connectionById.get(connectionId);
  if (!connection) {
    return;
  }
  connectionById.delete(connectionId);
  const ids = connectionIdsByDeviceId.get(connection.deviceId);
  if (!ids) {
    return;
  }
  ids.delete(connectionId);
  if (ids.size === 0) {
    connectionIdsByDeviceId.delete(connection.deviceId);
  }
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [hostToken, host] of hostsByToken.entries()) {
    if (host.updatedAtMs + HOST_TTL_MS <= nowMs) {
      hostsByToken.delete(hostToken);
      for (const [deviceId, device] of devicesById.entries()) {
        if (device.hostToken === hostToken) {
          devicesById.delete(deviceId);
          deviceIdByApiKeyHash.delete(device.apiKeyHash);
          const ids = connectionIdsByDeviceId.get(deviceId);
          if (ids) {
            for (const connectionId of ids) {
              connectionById.delete(connectionId);
            }
            connectionIdsByDeviceId.delete(deviceId);
          }
        }
      }
    }
  }
  for (const [connectionId, connection] of connectionById.entries()) {
    if (connection.touchedAtMs + CONNECTION_TTL_MS <= nowMs) {
      removeConnection(connectionId);
    }
  }
}

function toDeviceView(device: DeviceRecord) {
  return {
    deviceId: device.deviceId,
    name: device.name,
    icon: device.icon,
    apiKey: device.apiKey,
    createdAt: isoAt(device.createdAtMs),
    ...(device.lastResolvedAtMs !== null ? { lastResolvedAt: isoAt(device.lastResolvedAtMs) } : {}),
    ...(device.revokedAtMs !== null ? { revokedAt: isoAt(device.revokedAtMs) } : {}),
    activeConnectionCount: connectionIdsByDeviceId.get(device.deviceId)?.size ?? 0,
  };
}

function findDeviceByApiKey(apiKey: string): DeviceRecord | null {
  const deviceId = deviceIdByApiKeyHash.get(hashApiKey(apiKey));
  if (!deviceId) {
    return null;
  }
  return devicesById.get(deviceId) ?? null;
}

async function handleRequest(request: Http.IncomingMessage, response: Http.ServerResponse) {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  pruneExpired();

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/v1/hosts/register") {
    const body = await readBody(request).catch(() => null);
    if (!isObjectRecord(body)) {
      writeJson(response, 400, { error: "Host register body must be a JSON object." });
      return;
    }
    const hostToken = asNonEmptyString(body.hostToken);
    const wsUrl = asNonEmptyString(body.wsUrl)?.trim() ?? null;
    const normalizedWsUrl = wsUrl ? normalizeWsUrl(wsUrl) : null;
    if (!hostToken || !wsUrl) {
      writeJson(response, 400, { error: "Host register requires hostToken and wsUrl." });
      return;
    }
    if (!normalizedWsUrl) {
      writeJson(response, 400, {
        error: "Host register wsUrl must be a valid ws:// or wss:// URL.",
      });
      return;
    }
    const nowMs = Date.now();
    const existing = hostsByToken.get(hostToken);
    if (existing) {
      existing.wsUrl = normalizedWsUrl;
      existing.updatedAtMs = nowMs;
    } else {
      hostsByToken.set(hostToken, {
        hostToken,
        wsUrl: normalizedWsUrl,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    writeJson(response, 200, {
      hostToken,
      wsUrl: normalizedWsUrl,
      updatedAt: isoAt(nowMs),
    });
    return;
  }

  if (method === "GET" && /^\/v1\/hosts\/[^/]+\/devices$/.test(requestUrl.pathname)) {
    const hostToken = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const relayUrl = new URL("/v1/resolve", resolvePublicBaseUrl(request)).toString();
    const devices = Array.from(devicesById.values())
      .filter((device) => device.hostToken === hostToken)
      .toSorted((a, b) => b.createdAtMs - a.createdAtMs)
      .map((device) => toDeviceView(device));
    writeJson(response, 200, {
      hostToken,
      relayUrl,
      wsUrl: host.wsUrl,
      devices,
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/v1/hosts/device-tokens") {
    const body = await readBody(request).catch(() => null);
    if (!isObjectRecord(body)) {
      writeJson(response, 400, { error: "Device token body must be a JSON object." });
      return;
    }
    const hostToken = asNonEmptyString(body.hostToken);
    if (!hostToken) {
      writeJson(response, 400, { error: "Device token requires hostToken." });
      return;
    }
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const iconCandidate = asNonEmptyString(body.icon)?.toLowerCase();
    if (iconCandidate && !isValidDeviceIcon(iconCandidate)) {
      writeJson(response, 400, { error: "Device icon is invalid." });
      return;
    }
    const apiKey = `ace_rly_${Crypto.randomBytes(24).toString("base64url")}`;
    const nowMs = Date.now();
    const device: DeviceRecord = {
      deviceId: Crypto.randomUUID(),
      hostToken,
      apiKey,
      apiKeyHash: hashApiKey(apiKey),
      name: normalizeDeviceName(asNonEmptyString(body.name)),
      icon: iconCandidate && isValidDeviceIcon(iconCandidate) ? iconCandidate : "iphone",
      createdAtMs: nowMs,
      revokedAtMs: null,
      lastResolvedAtMs: null,
    };
    devicesById.set(device.deviceId, device);
    deviceIdByApiKeyHash.set(device.apiKeyHash, device.deviceId);
    const relayUrl = new URL("/v1/resolve", resolvePublicBaseUrl(request)).toString();
    writeJson(response, 200, {
      hostToken,
      relayUrl,
      wsUrl: host.wsUrl,
      device: toDeviceView(device),
    });
    return;
  }

  if (
    method === "POST" &&
    /^\/v1\/hosts\/[^/]+\/devices\/[^/]+\/revoke$/.test(requestUrl.pathname)
  ) {
    const [, , , hostTokenSegment, , deviceIdSegment] = requestUrl.pathname.split("/");
    const hostToken = decodeURIComponent(hostTokenSegment ?? "");
    const deviceId = decodeURIComponent(deviceIdSegment ?? "");
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const device = devicesById.get(deviceId);
    if (!device || device.hostToken !== hostToken) {
      writeJson(response, 404, { error: "Remote device was not found." });
      return;
    }
    if (device.revokedAtMs === null) {
      device.revokedAtMs = Date.now();
    }
    const ids = connectionIdsByDeviceId.get(device.deviceId);
    if (ids) {
      for (const connectionId of ids) {
        removeConnection(connectionId);
      }
    }
    const relayUrl = new URL("/v1/resolve", resolvePublicBaseUrl(request)).toString();
    writeJson(response, 200, {
      hostToken,
      relayUrl,
      wsUrl: host.wsUrl,
      device: toDeviceView(device),
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/v1/resolve") {
    const body = await readBody(request).catch(() => null);
    if (!isObjectRecord(body)) {
      writeJson(response, 400, { error: "Resolve body must be a JSON object." });
      return;
    }
    const hostToken = asNonEmptyString(body.hostToken);
    const apiKey = asNonEmptyString(body.apiKey);
    const lastKnownWsUrl = asNonEmptyString(body.lastKnownWsUrl);
    if (!hostToken || !apiKey) {
      writeJson(response, 400, { error: "Resolve requires hostToken and apiKey." });
      return;
    }
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const device = findDeviceByApiKey(apiKey);
    if (!device || device.hostToken !== hostToken) {
      writeJson(response, 401, { error: "Remote apiKey is invalid for this host." });
      return;
    }
    if (device.revokedAtMs !== null) {
      writeJson(response, 410, { error: "Remote apiKey has been revoked." });
      return;
    }
    const nowMs = Date.now();
    device.lastResolvedAtMs = nowMs;
    writeJson(response, 200, {
      name: device.name,
      wsUrl: host.wsUrl,
      authToken: device.apiKey,
      changed: !lastKnownWsUrl || lastKnownWsUrl !== host.wsUrl,
      resolvedAt: isoAt(nowMs),
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/v1/verify") {
    const body = await readBody(request).catch(() => null);
    if (!isObjectRecord(body)) {
      writeJson(response, 400, { error: "Verify body must be a JSON object." });
      return;
    }
    const hostToken = asNonEmptyString(body.hostToken);
    const apiKey = asNonEmptyString(body.apiKey);
    if (!hostToken || !apiKey) {
      writeJson(response, 400, { error: "Verify requires hostToken and apiKey." });
      return;
    }
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const device = findDeviceByApiKey(apiKey);
    if (!device || device.hostToken !== hostToken) {
      writeJson(response, 401, { error: "Remote apiKey is invalid for this host." });
      return;
    }
    if (device.revokedAtMs !== null) {
      writeJson(response, 410, { error: "Remote apiKey has been revoked." });
      return;
    }
    writeJson(response, 200, {
      valid: true,
      wsUrl: host.wsUrl,
      device: toDeviceView(device),
    });
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/v1/activity") {
    const body = await readBody(request).catch(() => null);
    if (!isObjectRecord(body)) {
      writeJson(response, 400, { error: "Activity body must be a JSON object." });
      return;
    }
    const hostToken = asNonEmptyString(body.hostToken);
    const apiKey = asNonEmptyString(body.apiKey);
    const connectionId = asNonEmptyString(body.connectionId);
    const clientSessionId = asNonEmptyString(body.clientSessionId);
    const status = asNonEmptyString(body.status);
    if (!hostToken || !apiKey || !connectionId || !clientSessionId) {
      writeJson(response, 400, {
        error: "Activity requires hostToken, apiKey, clientSessionId, and connectionId.",
      });
      return;
    }
    if (status !== "connected" && status !== "disconnected") {
      writeJson(response, 400, { error: "Activity status must be connected or disconnected." });
      return;
    }
    const host = hostsByToken.get(hostToken);
    if (!host) {
      writeJson(response, 404, { error: "Host token was not found." });
      return;
    }
    const device = findDeviceByApiKey(apiKey);
    if (!device || device.hostToken !== hostToken || device.revokedAtMs !== null) {
      writeJson(response, 401, { error: "Remote apiKey is invalid for this host." });
      return;
    }
    const nowMs = Date.now();
    if (status === "connected") {
      connectionById.set(connectionId, {
        connectionId,
        clientSessionId,
        hostToken,
        deviceId: device.deviceId,
        connectedAtMs: nowMs,
        touchedAtMs: nowMs,
      });
      ensureConnectionSet(device.deviceId).add(connectionId);
    } else {
      removeConnection(connectionId);
    }
    writeJson(response, 200, {
      ok: true,
      activeConnectionCount: connectionIdsByDeviceId.get(device.deviceId)?.size ?? 0,
    });
    return;
  }

  writeNotFound(response);
}

const port = Number.parseInt(process.env.RELAY_PORT ?? "", 10) || DEFAULT_PORT;
const host = process.env.RELAY_HOST?.trim() || "0.0.0.0";

const server = Http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unexpected relay server failure.",
    });
  });
});

server.listen(port, host, () => {
  console.log(`[relay] listening on http://${host}:${String(port)}`);
});
