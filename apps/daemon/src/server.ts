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
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientMessage,
  HostId,
  type DeviceId,
  type ServerMessage,
  type DiagnosticsHealth,
} from "@ace/protocol";
import { commandContext, type CommandHandler } from "./commands.ts";
import { defaultPressure, Outbox, type PressureOptions } from "./outbox.ts";
import type { Store } from "./store.ts";
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
  replayLimit?: number;
  idleTimeoutMs?: number;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  health?: () => Promise<DiagnosticsHealth>;
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
export async function startServer(options: ServerOptions): Promise<{
  url: string;
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
    for (const [socket, device] of authenticated)
      if (device.revocable && device.id === id) {
        cleanups.get(socket)?.();
        socket.close(4003, "Device revoked");
        socket.terminate();
      }
  });
  const cleanups = new Map<WebSocket, () => void>();
  const ticks = new Map<WebSocket, () => void>();
  wss.on("connection", (socket, isLocal: boolean) => {
    let device: DeviceId | undefined;
    let healthPending = false;
    let lastActivity = auth.now();
    const subscriptions = new Map<string, () => void>();
    const outbox = new Outbox(socket, { ...defaultPressure, ...options.pressure });
    const send = (message: ServerMessage) => outbox.send(message);
    const fail = (code: string, message: string, close = false) => {
      send({ type: "error", code, message });
      if (close) socket.close(4001, code);
    };
    const cleanup = () => {
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      outbox.clear();
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
    socket.on("message", (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      lastActivity = auth.now();
      let message: ClientMessage;
      try {
        if (binary) throw new Error("Text required");
        message = ClientMessage.parse(JSON.parse(data.toString()));
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
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
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
        case "command": {
          const scope = message.command.payload.type === "diagnostics.health" ? "read" : "operate";
          if (!allows(authenticated.get(socket), scope)) {
            fail("forbidden", `${scope === "read" ? "Read" : "Operate"} scope required`);
            break;
          }
          if (message.command.deviceId !== device) {
            fail("device_mismatch", "Command device must match hello");
            break;
          }
          if (message.command.payload.type === "diagnostics.health") {
            if (!options.health) {
              send({
                type: "commandResult",
                commandId: message.command.id,
                ok: false,
                error: "diagnostics_unavailable",
              });
              break;
            }
            if (healthPending) {
              send({
                type: "commandResult",
                commandId: message.command.id,
                ok: false,
                error: "diagnostics_busy",
              });
              break;
            }
            healthPending = true;
            void Promise.resolve()
              .then(options.health)
              .then(
                (health) =>
                  send({ type: "commandResult", commandId: message.command.id, ok: true, health }),
                () =>
                  send({
                    type: "commandResult",
                    commandId: message.command.id,
                    ok: false,
                    error: "diagnostics_failed",
                  }),
              )
              .finally(() => {
                healthPending = false;
              });
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
    });
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
