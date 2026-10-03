import type { HistoryScanStatus } from "@ace/protocol/history";
import { startTransports } from "./services/transports.ts";
import { createSocketRegistry, parseSocketMessage } from "./services/registry.ts";
import type { SocketMessage } from "./services/socket.ts";
import { previewHttp } from "./preview-http.ts";
import { createDaemonPreview, type DaemonPreview } from "./preview.ts";
import { MaintenanceGate } from "@ace/service";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { generateSecret, systemCredentials } from "./credential-runtime.ts";
import { z } from "zod";
import { defaultTicketLimits } from "./ticket-pool.ts";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { accessHttp } from "./access-http.ts";
import { allows, type Device } from "./devices.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { urlHost } from "./network.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HostId, DeviceId, type ServerMessage, type Notification } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import { defaultPressure, Outbox } from "./outbox.ts";
import { SocketInput } from "./socket-input.ts";
import { subscribe } from "./subscription.ts";
const bind = (listener: Server, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => {
      listener.removeListener("error", reject);
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing listener address"));
        return;
      }
      resolve(address.port);
    });
  });
const closeListener = (listener: Server) =>
  new Promise<void>((resolve) => {
    listener.close(() => resolve());
    listener.closeAllConnections();
  });

export type { ServerOptions } from "./server-options.ts";
import type { ServerOptions } from "./server-options.ts";
export async function startServer(options: ServerOptions): Promise<{
  relayHostId?: string;
  maintenance: MaintenanceGate;
  url: string;
  notify(device: DeviceId, notification: Notification): boolean;
  notificationDevices(): readonly DeviceId[];
  broadcastHistoryScan(scan: HistoryScanStatus): void;
  preview?: DaemonPreview;
  httpUrl: string;
  diagnosticsQueues(): { socketInput: number; healthRequests: number };
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const runtime = {
    ...systemDeliveryRuntime,
    ...options.runtime,
    now: options.now ?? options.runtime?.now ?? systemDeliveryRuntime.now,
  };
  const hostId = HostId.parse(options.hostId);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Invalid server token");
  const auth = new RemoteAuth(
    options.store.devices,
    options.token,
    {
      now: runtime.now,
      secret: () => generateSecret(options.entropy ?? systemCredentials.randomBytes),
    },
    z
      .object({
        global: z.number().int().positive(),
        perDevice: z.number().int().positive(),
        perMinute: z.number().int().positive(),
      })
      .parse({ ...defaultTicketLimits, ...options.ticketLimits }),
  );
  let remoteOrigin: string | undefined;
  const pairing = () =>
    options.remote && remoteOrigin
      ? { origin: remoteOrigin, fingerprint: options.remote.identity.fingerprint }
      : undefined;
  let preview: DaemonPreview | undefined;
  const maintenance = new MaintenanceGate(() => options.store.updateBlockers());
  if (options.maintenance) maintenance.enter();
  const local = httpServer(
    previewHttp(
      () => preview,
      accessHttp(
        auth,
        auth.localBearer.bind(auth),
        pairing,
        options.pairingAddress,
        maintenance,
        options.version,
        options.serviceStatus,
      ),
    ),
  );
  const remote = options.remote
    ? httpsServer(
        { ...options.remote.identity, minVersion: "TLSv1.2" },
        previewHttp(
          () => preview,
          accessHttp(
            auth,
            auth.deviceBearer.bind(auth),
            pairing,
            options.pairingAddress,
            undefined,
            options.version,
            options.serviceStatus,
          ),
        ),
      )
    : undefined;
  for (const listener of [local, remote])
    if (listener) {
      listener.requestTimeout = 10_000;
      listener.headersTimeout = 10_000;
    }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const attach = (listener: Server, isLocal: boolean) =>
    listener.on("upgrade", (request, socket, head) => {
      if (request.url !== "/") {
        socket.destroy();
        return;
      }
      if (cleanups.size >= 256) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          () => socket.destroy(),
        );
        return;
      }
      wss.handleUpgrade(request, socket, head, (websocket) =>
        wss.emit("connection", websocket, isLocal),
      );
    });
  attach(local, true);
  if (remote) attach(remote, false);
  const authenticated = new Map<WebSocket, Device & { revocable: boolean }>();
  const stopRevocation = auth.onRevoke((id) => {
    preview?.revokeDevice(id);
    void options.notifications
      ?.revoke?.(DeviceId.parse(id))
      .catch(() => options.log?.(new Error("Notification revocation failed")));
    for (const [socket, device] of authenticated)
      if (device.revocable && device.id === id) {
        cleanups.get(socket)?.();
        socket.close(4003, "Device revoked");
        socket.terminate();
      }
  });
  const createServiceSessions = createSocketRegistry();
  const serviceTasks = new Set<Promise<void>>();
  const serviceSessions = new Map<WebSocket, ReturnType<typeof createServiceSessions>>();
  const input = new SocketInput();
  const cleanups = new Map<WebSocket, () => void>();
  let disconnects = Promise.resolve();
  let disconnectError: Error | undefined;
  const receivers = new Map<DeviceId, Map<WebSocket, (message: ServerMessage) => void>>();
  const ticks = new Map<WebSocket, () => void>();
  wss.on("connection", (socket, isLocal: boolean) => {
    socket.on("error", (error) => {
      options.log?.(error);
      socket.terminate();
    });
    if (cleanups.size >= 256) {
      socket.terminate();
      return;
    }
    const sessionId = z.string().min(1).max(200).parse(runtime.id());
    let device: DeviceId | undefined;
    let hasPresence = false;
    let cleaned = false;
    let lastActivity = auth.now();
    const subscriptions = new Map<string, () => void>();
    const outbox = new Outbox(socket, { ...defaultPressure, ...options.pressure }, runtime.now);
    const send = (message: ServerMessage | PluginServerMessage) => outbox.send(message);
    const fail = (
      code: string,
      message: string,
      close = false,
      scope: { requestId?: string; subscriptionId?: string } = {},
    ) => {
      send({ type: "error", code, message, ...scope });
      if (close) socket.close(4001, code);
    };
    const authorize = (scope: import("@ace/protocol").DeviceScope) => {
      const actor = authenticated.get(socket);
      const current = actor?.revocable ? options.store.devices.get(actor.id) : actor;
      return current?.revokedAt === null && allows(current, scope);
    };
    const sessions = createServiceSessions({
      options,
      socket,
      sessionId,
      onPresence: () => {
        hasPresence = true;
      },
      subscriptions,
      tasks: serviceTasks,
      maintenance,
      device: () => device,
      authorize,
      canReadThread: (thread) =>
        device !== undefined && options.canReadThread?.(device, thread) !== false,
      connected: () => socket.readyState === WebSocket.OPEN && authenticated.has(socket),
      send,
      fail,
    });
    serviceSessions.set(socket, sessions);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const service of sessions) service.close?.();
      serviceSessions.delete(socket);
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      outbox.clear();
      if (device) {
        const connections = receivers.get(device);
        connections?.delete(socket);
        if (!connections?.size) receivers.delete(device);
      }
      if (hasPresence) {
        // Retain this socket's admission slot until removal is acknowledged. Active
        // sockets plus queued removals therefore remain bounded at 256 under churn.
        disconnects = disconnects
          .then(() => options.notifications?.disconnect(sessionId))
          .then(() => {
            cleanups.delete(socket);
          })
          .catch((error: unknown) => {
            disconnectError = error instanceof Error ? error : new Error("Presence cleanup failed");
            options.log?.(disconnectError);
          });
      } else cleanups.delete(socket);
      ticks.delete(socket);
      authenticated.delete(socket);
    };
    cleanups.set(socket, cleanup);
    ticks.set(socket, () => {
      if (auth.now() - lastActivity > (options.idleTimeoutMs ?? 60_000))
        socket.close(4008, "Idle timeout");
      outbox.tick();
    });
    socket.on("close", () => {
      cleanup();
      options.onDisconnect?.(device);
    });
    const receive = async (data: RawData, binary: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      lastActivity = auth.now();
      let message: SocketMessage;
      try {
        if (binary) {
          const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (!device || !sessions.some((service) => service.binary?.(frame)))
            throw new Error("No binary channel");
          return;
        }
        message = parseSocketMessage(JSON.parse(data.toString()));
      } catch {
        fail(
          device ? "invalid_message" : "unauthorized",
          "Message does not match the protocol",
          !device,
        );
        return;
      }
      if (!device) {
        if (message.type !== "hello") {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        const actor =
          message.ticket !== undefined
            ? auth.consume(message.ticket)
            : message.token !== undefined && isLocal && auth.local(message.token)
              ? {
                  id: message.deviceId,
                  name: "Host",
                  scopes: ["admin"] as const,
                  createdAt: 0,
                  lastSeenAt: auth.now(),
                  revokedAt: null,
                }
              : undefined;
        if (!actor || (message.ticket !== undefined && actor.id !== message.deviceId)) {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        device = actor.id;
        authenticated.set(socket, {
          ...actor,
          scopes: [...actor.scopes],
          revocable: message.ticket !== undefined,
        });
        try {
          if (authorize("read")) await options.notifications?.connectDevice(actor.id);
        } catch {
          fail("device_unavailable", "Device unavailable", true);
          return;
        }
        // Authentication may finish after disconnect, revocation or daemon shutdown.
        if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
        if (authorize("read")) {
          let connections = receivers.get(device);
          if (!connections) {
            connections = new Map();
            receivers.set(device, connections);
          }
          connections.set(socket, send);
        }
        for (const service of sessions) service.authenticated?.();
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
      for (const service of sessions) if (await service.handle?.(message, device)) return;
      switch (message.type) {
        case "hello":
          fail("unauthorized", "Hello is only valid once", true);
          break;
        case "ping":
          send({ type: "pong" });
          break;
        case "unsubscribe":
          subscriptions.get(message.subscriptionId)?.();
          subscriptions.delete(message.subscriptionId);
          break;
        case "subscribe": {
          if (!authorize("read")) {
            fail("forbidden", "Read scope required", false, {
              subscriptionId: message.subscriptionId,
            });
            break;
          }
          subscriptions.get(message.subscriptionId)?.();
          subscriptions.delete(message.subscriptionId);
          if (subscriptions.size >= 64) {
            fail("subscription_limit", "Too many subscriptions", false, {
              subscriptionId: message.subscriptionId,
            });
            break;
          }
          if (
            message.scope.kind === "thread" &&
            options.canReadThread?.(device, message.scope.threadId) === false
          ) {
            fail("read_denied", "Thread is not readable", false, {
              subscriptionId: message.subscriptionId,
            });
            break;
          }
          try {
            const stop = subscribe(
              options.store,
              message.subscriptionId,
              message.scope,
              message.afterSeq,
              options.replayLimit ?? 5000,
              send,
              250,
              runtime.delay,
            );
            subscriptions.set(message.subscriptionId, stop);
          } catch {
            fail("subscribe_failed", "Unknown thread or invalid cursor", false, {
              subscriptionId: message.subscriptionId,
            });
          }
          break;
        }
        case "output.read": {
          if (!authorize("read")) {
            fail("forbidden", "Read scope required", false, { requestId: message.requestId });
            break;
          }
          const threadId = options.store.outputThread(message.streamId);
          if (!threadId || options.canReadThread?.(device, threadId) === false) {
            fail("read_denied", "Output stream is not readable", false, {
              requestId: message.requestId,
            });
            break;
          }
          send({
            type: "output.data",
            requestId: message.requestId,
            streamId: message.streamId,
            offset: message.offset,
            ...options.store.readOutput(message.streamId, message.offset, message.limit),
          });
          break;
        }
        case "items.page": {
          if (!authorize("read")) {
            fail("forbidden", "Read scope required", false, { requestId: message.requestId });
            break;
          }
          if (
            !options.store.getThread(message.threadId) ||
            options.canReadThread?.(device, message.threadId) === false
          ) {
            fail("read_denied", "Thread is not readable", false, { requestId: message.requestId });
            break;
          }
          try {
            send({
              type: "items.page",
              requestId: message.requestId,
              ...options.store.readItemPage(
                message.threadId,
                message.before,
                message.limit,
                1024 * 1024 -
                  Buffer.byteLength(
                    JSON.stringify({
                      type: "items.page",
                      requestId: message.requestId,
                      threadId: message.threadId,
                    }),
                  ) -
                  128,
              ),
            });
          } catch {
            fail("read_denied", "Invalid item cursor", false, { requestId: message.requestId });
          }
          break;
        }
        case "command": {
          const route = sessions
            .flatMap((service) => (service.command ? [service.command] : []))
            .find((service) => service.types.includes(message.command.payload.type));
          const scope = route?.scope(message.command) ?? "operate";
          if (!authorize(scope)) {
            fail("forbidden", `${scope} scope required`);
            break;
          }
          try {
            if (authorize("read")) await options.notifications?.connectDevice(device);
          } catch {
            fail("device_unavailable", "Device unavailable", true);
            break;
          }
          if (socket.readyState !== WebSocket.OPEN || !authenticated.has(socket)) break;
          if (!authorize(scope)) {
            fail("forbidden", `${scope} scope required`);
            break;
          }
          if (message.command.deviceId !== device) {
            fail("device_mismatch", "Command device must match hello");
            break;
          }
          if (!maintenance.admitCommand(message.command)) {
            fail("maintenance", "Daemon is draining for an update");
            break;
          }
          try {
            if (route) await route.accept(message.command, device);
            else
              send({
                type: "commandResult",
                commandId: message.command.id,
                ok: false,
                error: "not_implemented",
              });
          } catch (error) {
            options.log?.(error);
            fail("command_failed", "Command transaction rolled back");
          }
          break;
        }
      }
    };
    input.listen(socket, receive, (error) => options.log?.(error));
  });
  const stopTimer = runtime.every(
    () => {
      for (const tick of ticks.values()) tick();
    },
    Math.max(10, Math.min(1000, (options.idleTimeoutMs ?? 60_000) / 2)),
  );
  let port: number;
  let transports: Awaited<ReturnType<typeof startTransports>> | undefined;
  try {
    port = await bind(local, "127.0.0.1", options.port);
    if (remote && options.remote) {
      const remotePort = await bind(remote, options.remote.host, options.remote.port);
      remoteOrigin = `https://${urlHost(options.remote.advertisedHost)}:${remotePort}`;
    }
    transports = await startTransports(options, auth);
    if (options.preview)
      preview = await createDaemonPreview(options.store, options.preview, auth.now);
  } catch (error) {
    stopTimer();
    await transports?.close();
    await preview?.close();
    stopRevocation();
    await closeListener(local);
    if (remote) await closeListener(remote);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...(preview ? { preview } : {}),
    ...(transports?.relayHostId ? { relayHostId: transports.relayHostId } : {}),
    maintenance,
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    diagnosticsQueues: () => ({
      socketInput: input.depth(),
      healthRequests: [...serviceSessions.values()].reduce(
        (count, sessions) =>
          count + sessions.reduce((sum, service) => sum + (service.healthPending?.() ?? 0), 0),
        0,
      ),
    }),
    ...(remoteOrigin && options.remote
      ? {
          remoteUrl: remoteOrigin.replace("https:", "wss:"),
          fingerprint: options.remote.identity.fingerprint,
        }
      : {}),
    broadcastHistoryScan(scan) {
      for (const [socket, actor] of authenticated) {
        const current = actor.revocable ? options.store.devices.get(actor.id) : actor;
        if (
          socket.readyState === WebSocket.OPEN &&
          current?.revokedAt === null &&
          allows(current, "read")
        )
          receivers.get(actor.id)?.get(socket)?.({ type: "history.scan.updated", scan });
      }
    },
    notificationDevices: () => [...receivers.keys()],
    notify(device, notification) {
      let delivered = false;
      for (const [socket, send] of receivers.get(device) ?? []) {
        if (socket.readyState === WebSocket.OPEN) {
          send({ type: "notification", notification });
          delivered = true;
        }
      }
      return delivered;
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        stopTimer();
        stopRevocation();
        for (const cleanup of cleanups.values()) cleanup();
        for (const socket of wss.clients) {
          socket.close(1001, "Daemon shutdown");
          socket.terminate();
        }
        void Promise.all([
          closeListener(local),
          ...(remote ? [closeListener(remote)] : []),
          preview?.close(),
          transports?.close(),
        ]).then(
          () =>
            wss.close((error) => {
              void Promise.all([Promise.allSettled(serviceTasks), disconnects]).then(() => {
                if (error) reject(error);
                else if (disconnectError) reject(disconnectError);
                else resolve();
              }, reject);
            }),
          reject,
        );
      });
      return closing;
    },
  };
}
