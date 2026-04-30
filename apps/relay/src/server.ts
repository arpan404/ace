type RelayRole = "host" | "viewer";
type RelayRouteState = "pending" | "ready";

interface RelaySocketHandle {
  data: RelaySocketData;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RelaySocketData {
  connectionId: string;
  role: RelayRole | null;
  deviceId: string | null;
  deviceName: string | null;
  identityPublicKey: string | null;
  routes: Set<string>;
  connectedAt: string;
  lastSeenAtMs: number;
}

interface RegisteredRelayClient {
  readonly connectionId: string;
  readonly role: RelayRole;
  readonly deviceId: string;
  readonly identityPublicKey: string;
  readonly socket: RelaySocketHandle;
  readonly connectedAt: string;
  deviceName: string | null;
}

interface RelayRoute {
  readonly routeId: string;
  readonly hostDeviceId: string;
  readonly viewerDeviceId: string;
  readonly hostConnectionId: string;
  readonly viewerConnectionId: string;
  readonly hostSocket: RelaySocketHandle;
  readonly viewerSocket: RelaySocketHandle;
  readonly relayUrl: string;
  createdAt: string;
  lastActivityAt: string;
  keyEpoch: number;
  state: RelayRouteState;
}

interface RelayConfig {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly pairingTtlMs: number;
  readonly idleRouteTtlMs: number;
  readonly maxFrameBytes: number;
  readonly maxConnections: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

type RelayEnvelope = Record<string, unknown>;

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_IDLE_ROUTE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_FRAME_BYTES = 1_000_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;
const PING_INTERVAL_MS = 30_000;
const WS_PATH = "/v1/ws";
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;
const CLIENT_IDLE_TIMEOUT_MS = 90_000;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_NAME_LENGTH = 160;
const MAX_PUBLIC_KEY_LENGTH = 128;
const MAX_ROUTE_ID_LENGTH = 128;
const MAX_CLIENT_CONNECTION_ID_LENGTH = 128;
const MAX_PAIRING_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_ROUTE_AUTH_PROOF_LENGTH = 128;
const MAX_ROUTE_CLOSE_REASON_LENGTH = 128;
const MAX_ROUTE_ERROR_LENGTH = 256;

function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLogLevel(): RelayConfig["logLevel"] {
  const raw = process.env.ACE_RELAY_LOG_LEVEL?.trim().toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

function computePublicUrl(host: string, port: number): string {
  const configured = process.env.ACE_RELAY_PUBLIC_URL?.trim();
  if (configured) {
    return configured;
  }
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `ws://${normalizedHost}:${String(port)}${WS_PATH}`;
}

function loadConfig(): RelayConfig {
  const host = process.env.ACE_RELAY_HOST?.trim() || DEFAULT_HOST;
  const port = readIntEnv("ACE_RELAY_PORT", DEFAULT_PORT);
  return {
    host,
    port,
    publicUrl: computePublicUrl(host, port),
    pairingTtlMs: readIntEnv("ACE_RELAY_PAIRING_TTL_MS", DEFAULT_PAIRING_TTL_MS),
    idleRouteTtlMs: readIntEnv("ACE_RELAY_IDLE_ROUTE_TTL_MS", DEFAULT_IDLE_ROUTE_TTL_MS),
    maxFrameBytes: readIntEnv("ACE_RELAY_MAX_FRAME_BYTES", DEFAULT_MAX_FRAME_BYTES),
    maxConnections: readIntEnv("ACE_RELAY_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS),
    logLevel: readLogLevel(),
  };
}

function shouldLog(config: RelayConfig, level: RelayConfig["logLevel"]): boolean {
  const order: ReadonlyArray<RelayConfig["logLevel"]> = ["debug", "info", "warn", "error"];
  return order.indexOf(level) >= order.indexOf(config.logLevel);
}

function log(
  config: RelayConfig,
  level: RelayConfig["logLevel"],
  message: string,
  detail?: unknown,
) {
  if (!shouldLog(config, level)) {
    return;
  }
  const line = `[relay] ${level.toUpperCase()} ${message}`;
  if (detail === undefined) {
    console.log(line);
    return;
  }
  console.log(line, detail);
}

function sendEnvelope(socket: RelaySocketHandle, envelope: RelayEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

function sendRelayError(
  socket: RelaySocketHandle,
  code: string,
  message: string,
  routeId?: string,
): void {
  sendEnvelope(socket, {
    version: 1,
    type: "relay.error",
    code,
    message,
    ...(routeId ? { routeId } : {}),
  });
}

function sendRouteClosed(socket: RelaySocketHandle, routeId: string, reason: string): void {
  sendEnvelope(socket, {
    version: 1,
    type: "relay.route.close",
    routeId,
    reason,
  });
}

function parseEnvelope(raw: string | Buffer): RelayEnvelope | null {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RelayEnvelope) : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.trim().length <= maxLength;
}

function closeRoute(
  routes: Map<string, RelayRoute>,
  routeId: string,
  reason: string,
  options?: { readonly notifyHost?: boolean; readonly notifyViewer?: boolean },
): void {
  const route = routes.get(routeId);
  if (!route) {
    return;
  }
  routes.delete(routeId);
  route.hostSocket.data.routes.delete(routeId);
  route.viewerSocket.data.routes.delete(routeId);
  if (options?.notifyHost !== false) {
    sendRouteClosed(route.hostSocket, routeId, reason);
  }
  if (options?.notifyViewer !== false) {
    sendRouteClosed(route.viewerSocket, routeId, reason);
  }
}

function buildMetrics(input: {
  readonly config: RelayConfig;
  readonly liveSockets: Map<string, RelaySocketHandle>;
  readonly hosts: Map<string, RegisteredRelayClient>;
  readonly viewers: Map<string, RegisteredRelayClient>;
  readonly routes: Map<string, RelayRoute>;
}): string {
  return [
    "# HELP ace_relay_connections Total live relay websocket connections.",
    "# TYPE ace_relay_connections gauge",
    `ace_relay_connections ${String(input.liveSockets.size)}`,
    "# HELP ace_relay_hosts Total registered host devices.",
    "# TYPE ace_relay_hosts gauge",
    `ace_relay_hosts ${String(input.hosts.size)}`,
    "# HELP ace_relay_viewers Total registered viewer devices.",
    "# TYPE ace_relay_viewers gauge",
    `ace_relay_viewers ${String(input.viewers.size)}`,
    "# HELP ace_relay_routes Total live relay routes.",
    "# TYPE ace_relay_routes gauge",
    `ace_relay_routes ${String(input.routes.size)}`,
    "# HELP ace_relay_max_connections Configured max websocket connections.",
    "# TYPE ace_relay_max_connections gauge",
    `ace_relay_max_connections ${String(input.config.maxConnections)}`,
    "",
  ].join("\n");
}

const config = loadConfig();
const liveSockets = new Map<string, RelaySocketHandle>();
const connections = new Map<string, RegisteredRelayClient>();
const hosts = new Map<string, RegisteredRelayClient>();
const viewers = new Map<string, RegisteredRelayClient>();
const routes = new Map<string, RelayRoute>();

const BunRuntime = (globalThis as { Bun?: { serve: (options: unknown) => unknown } }).Bun;
if (!BunRuntime) {
  throw new Error("The ace relay must run on Bun.");
}

const server = BunRuntime.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: Math.min(
    MAX_BUN_IDLE_TIMEOUT_SECONDS,
    Math.max(30, Math.ceil(config.idleRouteTtlMs / 1_000)),
  ),
  fetch(request: Request, serverInstance: unknown) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({
          ok: true,
          relayUrl: config.publicUrl,
          connections: liveSockets.size,
          routes: routes.size,
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }
    if (url.pathname === "/metrics") {
      return new Response(
        buildMetrics({
          config,
          liveSockets,
          hosts,
          viewers,
          routes,
        }),
        {
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          },
        },
      );
    }
    if (url.pathname !== WS_PATH) {
      return new Response("Not Found", { status: 404 });
    }
    if (liveSockets.size >= config.maxConnections) {
      return new Response("Relay is at capacity.", { status: 503 });
    }
    const connectionId = randomId();
    const connectedAt = new Date().toISOString();
    const upgraded = (
      serverInstance as {
        upgrade: (request: Request, options: { data: RelaySocketData }) => boolean;
      }
    ).upgrade(request, {
      data: {
        connectionId,
        role: null,
        deviceId: null,
        deviceName: null,
        identityPublicKey: null,
        routes: new Set<string>(),
        connectedAt,
        lastSeenAtMs: Date.now(),
      },
    });
    return upgraded ? undefined : new Response("Upgrade failed.", { status: 400 });
  },
  websocket: {
    open(socket: RelaySocketHandle) {
      liveSockets.set(socket.data.connectionId, socket);
      log(config, "debug", "connection opened", {
        connectionId: socket.data.connectionId,
      });
    },
    message(socket: RelaySocketHandle, rawMessage: string | Buffer) {
      socket.data.lastSeenAtMs = Date.now();
      const messageBytes =
        typeof rawMessage === "string"
          ? Buffer.byteLength(rawMessage, "utf8")
          : rawMessage.byteLength;
      if (messageBytes > config.maxFrameBytes) {
        socket.close(1_009, "message-too-large");
        return;
      }
      const envelope = parseEnvelope(rawMessage);
      if (!envelope || envelope.version !== 1 || !isNonEmptyString(envelope.type)) {
        sendRelayError(socket, "invalid_message", "Relay message must be valid JSON.");
        return;
      }

      const registerClient = (role: RelayRole) => {
        if (
          !isBoundedString(envelope.deviceId, MAX_DEVICE_ID_LENGTH) ||
          !isBoundedString(envelope.identityPublicKey, MAX_PUBLIC_KEY_LENGTH)
        ) {
          sendRelayError(socket, "invalid_register", "Relay registration is missing fields.");
          return;
        }

        const deviceId = envelope.deviceId.trim();
        const existing = (role === "host" ? hosts : viewers).get(deviceId);
        if (existing && existing.connectionId !== socket.data.connectionId) {
          sendRelayError(socket, "duplicate_device", "Relay device is already connected.");
          socket.close(1_008, "duplicate-device");
          return;
        }

        const client: RegisteredRelayClient = {
          connectionId: socket.data.connectionId,
          role,
          deviceId,
          identityPublicKey: envelope.identityPublicKey.trim(),
          socket,
          connectedAt: socket.data.connectedAt,
          deviceName: isBoundedString(envelope.deviceName, MAX_DEVICE_NAME_LENGTH)
            ? envelope.deviceName.trim()
            : null,
        };
        socket.data.role = role;
        socket.data.deviceId = client.deviceId;
        socket.data.deviceName = client.deviceName;
        socket.data.identityPublicKey = client.identityPublicKey;
        connections.set(socket.data.connectionId, client);
        if (role === "host") {
          hosts.set(client.deviceId, client);
        } else {
          viewers.set(client.deviceId, client);
        }
        log(config, "info", "client registered", {
          connectionId: client.connectionId,
          role,
          deviceId: client.deviceId,
        });
      };

      switch (envelope.type) {
        case "relay.host.register": {
          registerClient("host");
          return;
        }
        case "relay.viewer.register": {
          registerClient("viewer");
          return;
        }
        case "relay.route.open": {
          if (socket.data.role !== "viewer") {
            sendRelayError(socket, "invalid_role", "Only viewers can open relay routes.");
            return;
          }
          if (
            !isBoundedString(envelope.routeId, MAX_ROUTE_ID_LENGTH) ||
            !isBoundedString(envelope.hostDeviceId, MAX_DEVICE_ID_LENGTH) ||
            !isBoundedString(envelope.viewerDeviceId, MAX_DEVICE_ID_LENGTH) ||
            !isBoundedString(envelope.clientSessionId, MAX_CLIENT_CONNECTION_ID_LENGTH) ||
            !isBoundedString(envelope.connectionId, MAX_CLIENT_CONNECTION_ID_LENGTH) ||
            !isBoundedString(envelope.pairingId, MAX_PAIRING_ID_LENGTH) ||
            !isBoundedString(envelope.routeAuthIssuedAt, MAX_TIMESTAMP_LENGTH) ||
            !isBoundedString(envelope.routeAuthProof, MAX_ROUTE_AUTH_PROOF_LENGTH)
          ) {
            sendRelayError(socket, "invalid_route_open", "Relay route.open is missing fields.");
            return;
          }
          const routeId = envelope.routeId.trim();
          const host = hosts.get(envelope.hostDeviceId.trim());
          if (!host) {
            sendEnvelope(socket, {
              version: 1,
              type: "relay.route.ready",
              routeId,
              state: "closed",
              hostDeviceId: envelope.hostDeviceId.trim(),
              hostIdentityPublicKey: "",
              error: "Relay host is unavailable.",
            });
            return;
          }
          const viewerClient = connections.get(socket.data.connectionId);
          if (!viewerClient || !viewerClient.deviceId || !viewerClient.identityPublicKey) {
            sendRelayError(socket, "viewer_not_registered", "Viewer must register first.");
            return;
          }
          const route: RelayRoute = {
            routeId,
            hostDeviceId: host.deviceId,
            viewerDeviceId: viewerClient.deviceId,
            hostConnectionId: host.connectionId,
            viewerConnectionId: viewerClient.connectionId,
            hostSocket: host.socket,
            viewerSocket: socket,
            relayUrl: config.publicUrl,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            keyEpoch: 0,
            state: "pending",
          };
          routes.set(routeId, route);
          host.socket.data.routes.add(routeId);
          socket.data.routes.add(routeId);
          sendEnvelope(host.socket, {
            version: 1,
            type: "relay.route.request",
            routeId,
            hostDeviceId: host.deviceId,
            viewerDeviceId: viewerClient.deviceId,
            viewerDeviceName: viewerClient.deviceName ?? undefined,
            viewerIdentityPublicKey: viewerClient.identityPublicKey,
            clientSessionId: envelope.clientSessionId.trim(),
            connectionId: envelope.connectionId.trim(),
            pairingId: envelope.pairingId.trim(),
            routeAuthIssuedAt: envelope.routeAuthIssuedAt.trim(),
            routeAuthProof: envelope.routeAuthProof.trim(),
          });
          return;
        }
        case "relay.route.ready": {
          if (socket.data.role !== "host" || !isNonEmptyString(envelope.routeId)) {
            sendRelayError(socket, "invalid_route_ready", "Only hosts can confirm relay routes.");
            return;
          }
          const route = routes.get(envelope.routeId.trim());
          if (!route || route.hostConnectionId !== socket.data.connectionId) {
            sendRelayError(
              socket,
              "unknown_route",
              "Relay route was not found.",
              envelope.routeId.trim(),
            );
            return;
          }
          if (
            !isBoundedString(envelope.hostDeviceId, MAX_DEVICE_ID_LENGTH) ||
            !isBoundedString(envelope.hostIdentityPublicKey, MAX_PUBLIC_KEY_LENGTH)
          ) {
            sendRelayError(
              socket,
              "invalid_route_ready",
              "Relay route.ready is missing fields.",
              route.routeId,
            );
            closeRoute(routes, route.routeId, "host-ready-invalid", {
              notifyHost: false,
            });
            return;
          }
          if (envelope.state === "ready") {
            route.state = "ready";
            route.lastActivityAt = new Date().toISOString();
            sendEnvelope(route.viewerSocket, {
              version: 1,
              type: "relay.route.ready",
              routeId: route.routeId,
              state: "ready",
              hostDeviceId: envelope.hostDeviceId.trim(),
              hostIdentityPublicKey: envelope.hostIdentityPublicKey.trim(),
            });
            return;
          }
          sendEnvelope(route.viewerSocket, {
            version: 1,
            type: "relay.route.ready",
            routeId: route.routeId,
            state: "closed",
            hostDeviceId: envelope.hostDeviceId.trim(),
            hostIdentityPublicKey: envelope.hostIdentityPublicKey.trim(),
            error: isBoundedString(envelope.error, MAX_ROUTE_ERROR_LENGTH)
              ? envelope.error.trim()
              : "Relay route was rejected.",
          });
          closeRoute(routes, route.routeId, "route-rejected", {
            notifyHost: false,
            notifyViewer: false,
          });
          return;
        }
        case "relay.route.handshakeInit":
        case "relay.route.handshakeAck": {
          if (!isBoundedString(envelope.routeId, MAX_ROUTE_ID_LENGTH)) {
            sendRelayError(socket, "invalid_handshake", "Relay handshake is missing routeId.");
            return;
          }
          const route = routes.get(envelope.routeId.trim());
          if (!route) {
            sendRelayError(
              socket,
              "unknown_route",
              "Relay route was not found.",
              envelope.routeId.trim(),
            );
            return;
          }
          route.lastActivityAt = new Date().toISOString();
          if (envelope.type === "relay.route.handshakeInit") {
            if (route.viewerConnectionId !== socket.data.connectionId) {
              sendRelayError(
                socket,
                "invalid_role",
                "Only viewers can initiate relay handshakes.",
                route.routeId,
              );
              return;
            }
            sendEnvelope(route.hostSocket, envelope);
            return;
          }
          if (route.hostConnectionId !== socket.data.connectionId) {
            sendRelayError(
              socket,
              "invalid_role",
              "Only hosts can acknowledge relay handshakes.",
              route.routeId,
            );
            return;
          }
          sendEnvelope(route.viewerSocket, envelope);
          return;
        }
        case "relay.encryptedFrame": {
          if (
            !isNonEmptyString(envelope.routeId) ||
            !isNonEmptyString(envelope.ciphertext) ||
            !isNonEmptyString(envelope.nonce) ||
            typeof envelope.sequence !== "number" ||
            typeof envelope.keyEpoch !== "number" ||
            !isNonEmptyString(envelope.direction)
          ) {
            sendRelayError(socket, "invalid_frame", "Relay encryptedFrame is missing fields.");
            return;
          }
          const route = routes.get(envelope.routeId.trim());
          if (!route) {
            sendRelayError(
              socket,
              "unknown_route",
              "Relay route was not found.",
              envelope.routeId.trim(),
            );
            return;
          }
          const frameSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
          if (frameSize > config.maxFrameBytes) {
            closeRoute(routes, route.routeId, "frame-too-large");
            return;
          }
          const direction = envelope.direction.trim();
          if (
            (direction === "viewer_to_host" &&
              route.viewerConnectionId !== socket.data.connectionId) ||
            (direction === "host_to_viewer" && route.hostConnectionId !== socket.data.connectionId)
          ) {
            closeRoute(routes, route.routeId, "direction-mismatch");
            return;
          }
          route.keyEpoch = envelope.keyEpoch;
          route.lastActivityAt = new Date().toISOString();
          if (direction === "viewer_to_host") {
            sendEnvelope(route.hostSocket, envelope);
            return;
          }
          if (direction === "host_to_viewer") {
            sendEnvelope(route.viewerSocket, envelope);
            return;
          }
          closeRoute(routes, route.routeId, "direction-invalid");
          return;
        }
        case "relay.route.close": {
          if (!isBoundedString(envelope.routeId, MAX_ROUTE_ID_LENGTH)) {
            sendRelayError(socket, "invalid_route_close", "Relay route.close is missing routeId.");
            return;
          }
          const routeId = envelope.routeId.trim();
          const route = routes.get(routeId);
          if (!route) {
            return;
          }
          const reason = isBoundedString(envelope.reason, MAX_ROUTE_CLOSE_REASON_LENGTH)
            ? envelope.reason.trim()
            : "relay-route-closed";
          if (route.hostConnectionId === socket.data.connectionId) {
            closeRoute(routes, routeId, reason, { notifyHost: false });
            return;
          }
          if (route.viewerConnectionId === socket.data.connectionId) {
            closeRoute(routes, routeId, reason, { notifyViewer: false });
            return;
          }
          sendRelayError(
            socket,
            "invalid_role",
            "Relay route.close was sent by an unrelated socket.",
            routeId,
          );
          return;
        }
        case "relay.ping": {
          sendEnvelope(socket, {
            version: 1,
            type: "relay.pong",
            sentAt: isNonEmptyString(envelope.sentAt)
              ? envelope.sentAt.trim()
              : new Date().toISOString(),
          });
          return;
        }
        case "relay.pong": {
          return;
        }
        default: {
          sendRelayError(
            socket,
            "unsupported_message",
            `Relay does not support '${String(envelope.type)}'.`,
          );
        }
      }
    },
    close(socket: RelaySocketHandle) {
      liveSockets.delete(socket.data.connectionId);
      const connection = connections.get(socket.data.connectionId);
      if (connection) {
        if (connection.role === "host") {
          hosts.delete(connection.deviceId);
        } else {
          viewers.delete(connection.deviceId);
        }
      }
      connections.delete(socket.data.connectionId);
      for (const routeId of Array.from(socket.data.routes)) {
        const route = routes.get(routeId);
        if (!route) {
          continue;
        }
        if (route.hostConnectionId === socket.data.connectionId) {
          closeRoute(routes, routeId, "host-disconnected", { notifyHost: false });
        } else if (route.viewerConnectionId === socket.data.connectionId) {
          closeRoute(routes, routeId, "viewer-disconnected", { notifyViewer: false });
        }
      }
      log(config, "debug", "connection closed", {
        connectionId: socket.data.connectionId,
      });
    },
  },
});

setInterval(() => {
  const nowMs = Date.now();
  for (const socket of liveSockets.values()) {
    if (nowMs - socket.data.lastSeenAtMs > CLIENT_IDLE_TIMEOUT_MS) {
      socket.close(1_000, "client-idle-timeout");
    }
  }
  for (const route of routes.values()) {
    const idleMs = nowMs - Date.parse(route.lastActivityAt);
    if (Number.isFinite(idleMs) && idleMs > config.idleRouteTtlMs) {
      closeRoute(routes, route.routeId, "route-idle-timeout");
    }
  }
  for (const connection of connections.values()) {
    sendEnvelope(connection.socket, {
      version: 1,
      type: "relay.ping",
      sentAt: new Date().toISOString(),
    });
  }
}, PING_INTERVAL_MS);

log(config, "info", "relay listening", {
  host: config.host,
  port: config.port,
  publicUrl: config.publicUrl,
  pairingTtlMs: config.pairingTtlMs,
  idleRouteTtlMs: config.idleRouteTtlMs,
  maxFrameBytes: config.maxFrameBytes,
  maxConnections: config.maxConnections,
});

void server;
