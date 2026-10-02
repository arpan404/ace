import type { ModelCatalogApi } from "@ace/models";
import { handleModelRequest } from "./models.ts";
import { randomUUID } from "node:crypto";
import type { NotificationWorker } from "@ace/notify";
import { attachFilesSocket, type FilesService } from "@ace/files";
import { generateSecret, systemCredentials, type EntropySource } from "./credential-runtime.ts";
import { z } from "zod";
import { defaultTicketLimits, type TicketLimits } from "./ticket-pool.ts";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import type { Server, IncomingMessage } from "node:http";
import { accessHttp } from "./access-http.ts";
import { allows, type Device } from "./devices.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { urlHost, type RemoteListener } from "./network.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ClientMessage,
  HostId,
  DeviceId,
  type ServerMessage,
  type Notification,
  type ThreadId,
} from "@ace/protocol";
import { commandContext, type CommandHandler } from "./commands.ts";
import { defaultPressure, Outbox, type PressureOptions } from "./outbox.ts";
import type { Store } from "./store.ts";
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

export interface ServerOptions {
  models?: ModelCatalogApi;
  port: number;
  remote?: RemoteListener;
  now?: () => number;
  entropy?: EntropySource;
  pairingAddress?: (request: IncomingMessage) => string;
  ticketLimits?: Partial<TicketLimits>;
  token: string;
  hostId: string;
  store: Store;
  handler: CommandHandler;
  files?: FilesService;
  replayLimit?: number;
  idleTimeoutMs?: number;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  /** Local-token clients can read all threads by default. */
  canReadThread?: (deviceId: DeviceId, threadId: ThreadId) => boolean;
  notifications?: Pick<
    NotificationWorker,
    "connectDevice" | "disconnect" | "updatePresence" | "register" | "preferences" | "snooze"
  > &
    Partial<Pick<NotificationWorker, "revoke">>;
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
export async function startServer(options: ServerOptions): Promise<{
  url: string;
  notify(device: DeviceId, notification: Notification): boolean;
  httpUrl: string;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const hostId = HostId.parse(options.hostId);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Invalid server token");
  const auth = new RemoteAuth(
    options.store.devices,
    options.token,
    {
      now: options.now ?? Date.now,
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
  const local = httpServer(
    accessHttp(auth, auth.localBearer.bind(auth), pairing, options.pairingAddress),
  );
  const remote = options.remote
    ? httpsServer(
        { ...options.remote.identity, minVersion: "TLSv1.2" },
        accessHttp(auth, auth.deviceBearer.bind(auth), pairing, options.pairingAddress),
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
      wss.handleUpgrade(request, socket, head, (websocket) =>
        wss.emit("connection", websocket, isLocal),
      );
    });
  attach(local, true);
  if (remote) attach(remote, false);
  const authenticated = new Map<WebSocket, Device & { revocable: boolean }>();
  const stopRevocation = auth.onRevoke((id) => {
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
  const input = new SocketInput();
  const cleanups = new Map<WebSocket, () => void>();
  const receivers = new Map<DeviceId, Map<WebSocket, (message: ServerMessage) => void>>();
  const ticks = new Map<WebSocket, () => void>();
  wss.on("connection", (socket, isLocal: boolean) => {
    let modelRequests = 0;
    if (cleanups.size >= 256) {
      socket.close(4009, "Connection limit");
      return;
    }
    const sessionId = randomUUID();
    let device: DeviceId | undefined;
    let files: ReturnType<typeof attachFilesSocket> | undefined;
    let lastActivity = auth.now();
    const subscriptions = new Map<string, () => void>();
    const outbox = new Outbox(socket, { ...defaultPressure, ...options.pressure });
    const send = (message: ServerMessage) => outbox.send(message);
    const fail = (code: string, message: string, close = false) => {
      send({ type: "error", code, message });
      if (close) socket.close(4001, code);
    };
    const cleanup = () => {
      files?.close();
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      outbox.clear();
      if (device) {
        const connections = receivers.get(device);
        connections?.delete(socket);
        if (!connections?.size) receivers.delete(device);
      }
      void options.notifications?.disconnect(sessionId).catch(() => {});
      cleanups.delete(socket);
      ticks.delete(socket);
      authenticated.delete(socket);
    };
    cleanups.set(socket, cleanup);
    ticks.set(socket, () => {
      if (auth.now() - lastActivity > (options.idleTimeoutMs ?? 60_000))
        socket.close(4008, "Idle timeout");
      outbox.tick();
    });
    socket.on("error", (error) => {
      options.log?.(error);
      socket.terminate();
    });
    socket.on("close", () => {
      cleanup();
      options.onDisconnect?.(device);
    });
    const receive = async (data: RawData, binary: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      lastActivity = auth.now();
      let message: ClientMessage;
      try {
        if (binary) {
          if (!files) throw new Error("No file channel");
          files.binary(
            Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data),
          );
          return;
        }
        const decodedInput: unknown = JSON.parse(data.toString());
        if (
          files &&
          typeof decodedInput === "object" &&
          decodedInput !== null &&
          "type" in decodedInput &&
          typeof decodedInput.type === "string" &&
          decodedInput.type.startsWith("files.")
        ) {
          files.accept(decodedInput);
          return;
        }
        message = ClientMessage.parse(decodedInput);
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
          if (allows(authenticated.get(socket), "read"))
            await options.notifications?.connectDevice(actor.id);
        } catch {
          fail("device_unavailable", "Device unavailable", true);
          return;
        }
        // Authentication may finish after disconnect, revocation or daemon shutdown.
        if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
        if (allows(authenticated.get(socket), "read")) {
          let connections = receivers.get(device);
          if (!connections) {
            connections = new Map();
            receivers.set(device, connections);
          }
          connections.set(socket, send);
        }
        if (options.files)
          files = attachFilesSocket(options.files, socket, device, (capability) =>
            allows(authenticated.get(socket), capability === "files.read" ? "read" : "operate"),
          );
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
      switch (message.type) {
        case "files.request":
        case "files.credit":
        case "files.cancel":
          fail("files_unavailable", "File service unavailable");
          break;
        case "models.list":
        case "models.resolve":
        case "models.refresh": {
          const modelFailure = (reason: string) =>
            send({
              type: "models.result",
              requestId: message.requestId,
              result: { ok: false, reason },
            });
          const requiredScope = message.type === "models.refresh" ? "operate" : "read";
          if (!allows(authenticated.get(socket), requiredScope)) {
            modelFailure(`${requiredScope} scope required`);
            break;
          }
          if (!options.models) {
            modelFailure("Model catalog is not configured");
            break;
          }
          if (modelRequests >= 8) {
            modelFailure("Too many catalog requests");
            break;
          }
          modelRequests++;
          void handleModelRequest(options.models, message)
            .then(send, () => modelFailure("Model catalog request failed"))
            .finally(() => {
              modelRequests--;
            });
          break;
        }
        case "presence.update":
        case "notification.register":
        case "notification.preferences":
        case "notification.snooze": {
          const scope = message.type === "notification.snooze" ? "operate" : "read";
          if (!allows(authenticated.get(socket), scope)) {
            fail("forbidden", `${scope === "read" ? "Read" : "Operate"} scope required`);
            break;
          }
          if (!options.notifications) {
            fail("notifications_unavailable", "Notifications unavailable");
            break;
          }
          try {
            if (message.type === "presence.update")
              await options.notifications.updatePresence(sessionId, device, message);
            else if (message.type === "notification.register")
              await options.notifications.register(device, message.device);
            else if (message.type === "notification.preferences")
              await options.notifications.preferences(device, message.preferences);
            else await options.notifications.snooze(message.threadId, message.until);
          } catch {
            fail("notification_rejected", "Notification update rejected");
          }
          break;
        }
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
          if (!allows(authenticated.get(socket), "read")) {
            fail("forbidden", "Read scope required");
            break;
          }
          subscriptions.get(message.subscriptionId)?.();
          subscriptions.delete(message.subscriptionId);
          if (subscriptions.size >= 64) {
            fail("subscription_limit", "Too many subscriptions");
            break;
          }
          if (
            message.scope.kind === "thread" &&
            options.canReadThread?.(device, message.scope.threadId) === false
          ) {
            fail("read_denied", "Thread is not readable");
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
            );
            subscriptions.set(message.subscriptionId, stop);
          } catch {
            fail("subscribe_failed", "Unknown thread or invalid cursor");
          }
          break;
        }
        case "output.read": {
          if (!allows(authenticated.get(socket), "read")) {
            fail("forbidden", "Read scope required");
            break;
          }
          const threadId = options.store.outputThread(message.streamId);
          if (!threadId || options.canReadThread?.(device, threadId) === false) {
            fail("read_denied", "Output stream is not readable");
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
          if (!allows(authenticated.get(socket), "read")) {
            fail("forbidden", "Read scope required");
            break;
          }
          if (
            !options.store.getThread(message.threadId) ||
            options.canReadThread?.(device, message.threadId) === false
          ) {
            fail("read_denied", "Thread is not readable");
            break;
          }
          try {
            send({
              type: "items.page",
              requestId: message.requestId,
              ...options.store.readItems(message.threadId, message.before, message.limit),
            });
          } catch {
            fail("read_denied", "Invalid item cursor");
          }
          break;
        }
        case "command": {
          if (!allows(authenticated.get(socket), "operate")) {
            fail("forbidden", "Operate scope required");
            break;
          }
          try {
            if (allows(authenticated.get(socket), "read"))
              await options.notifications?.connectDevice(device);
          } catch {
            fail("device_unavailable", "Device unavailable", true);
            break;
          }
          if (socket.readyState !== WebSocket.OPEN || !authenticated.has(socket)) break;
          if (message.command.deviceId !== device) {
            fail("device_mismatch", "Command device must match hello");
            break;
          }
          try {
            const result = options.store.recordCommand(message.command.id, device, () =>
              options.handler.handle(message.command, commandContext(options.store)),
            );
            send({ type: "commandResult", ...result });
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
  const timer = setInterval(
    () => {
      for (const tick of ticks.values()) tick();
    },
    Math.max(10, Math.min(1000, (options.idleTimeoutMs ?? 60_000) / 2)),
  );
  timer.unref();
  let port: number;
  try {
    port = await bind(local, "127.0.0.1", options.port);
    if (remote && options.remote) {
      const remotePort = await bind(remote, options.remote.host, options.remote.port);
      remoteOrigin = `https://${urlHost(options.remote.advertisedHost)}:${remotePort}`;
    }
  } catch (error) {
    clearInterval(timer);
    stopRevocation();
    await closeListener(local);
    if (remote) await closeListener(remote);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    ...(remoteOrigin && options.remote
      ? {
          remoteUrl: remoteOrigin.replace("https:", "wss:"),
          fingerprint: options.remote.identity.fingerprint,
        }
      : {}),
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
        clearInterval(timer);
        stopRevocation();
        for (const cleanup of cleanups.values()) cleanup();
        for (const socket of wss.clients) {
          socket.close(1001, "Daemon shutdown");
          socket.terminate();
        }
        void Promise.all([closeListener(local), ...(remote ? [closeListener(remote)] : [])]).then(
          () =>
            wss.close((error) => {
              if (error) reject(error);
              else resolve();
            }),
        );
      });
      return closing;
    },
  };
}
