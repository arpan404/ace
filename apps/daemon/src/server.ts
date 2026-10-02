import { randomUUID } from "node:crypto";
import type { NotificationWorker } from "@ace/notify";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  ClientMessage,
  HostId,
  type DeviceId,
  type ServerMessage,
  type Notification,
} from "@ace/protocol";
import { commandContext, type CommandHandler } from "./commands.ts";
import { validToken } from "./local-files.ts";
import { defaultPressure, Outbox, type PressureOptions } from "./outbox.ts";
import type { Store } from "./store.ts";
import { SocketInput } from "./socket-input.ts";
import { subscribe } from "./subscription.ts";

export interface ServerOptions {
  port: number;
  token: string;
  hostId: string;
  store: Store;
  handler: CommandHandler;
  replayLimit?: number;
  idleTimeoutMs?: number;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  notifications?: Pick<
    NotificationWorker,
    "connectDevice" | "disconnect" | "updatePresence" | "register" | "preferences" | "snooze"
  >;
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
export async function startServer(options: ServerOptions): Promise<{
  url: string;
  notify(device: DeviceId, notification: Notification): boolean;
  close(): Promise<void>;
}> {
  const hostId = HostId.parse(options.hostId);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Invalid server token");
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    maxPayload: 1024 * 1024,
  });
  const input = new SocketInput();
  const cleanups = new Map<WebSocket, () => void>();
  const receivers = new Map<DeviceId, Map<WebSocket, (message: ServerMessage) => void>>();
  const ticks = new Map<WebSocket, () => void>();
  wss.on("connection", (socket) => {
    if (cleanups.size >= 256) {
      socket.close(4009, "Connection limit");
      return;
    }
    const sessionId = randomUUID();
    let device: DeviceId | undefined;
    let lastActivity = Date.now();
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
      if (device) {
        const connections = receivers.get(device);
        connections?.delete(socket);
        if (!connections?.size) receivers.delete(device);
      }
      void options.notifications?.disconnect(sessionId).catch(() => {});
      cleanups.delete(socket);
      ticks.delete(socket);
    };
    cleanups.set(socket, cleanup);
    ticks.set(socket, () => {
      if (Date.now() - lastActivity > (options.idleTimeoutMs ?? 60_000))
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
      lastActivity = Date.now();
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
        if (message.type !== "hello" || !validToken(message.token, options.token)) {
          fail("unauthorized", "Valid hello required", true);
          return;
        }
        try {
          await options.notifications?.connectDevice(message.deviceId);
        } catch {
          fail("device_unavailable", "Device unavailable", true);
          return;
        }
        // Authentication may finish after disconnect or daemon shutdown.
        if (socket.readyState !== WebSocket.OPEN || !cleanups.has(socket)) return;
        device = message.deviceId;
        let connections = receivers.get(device);
        if (!connections) {
          connections = new Map();
          receivers.set(device, connections);
        }
        connections.set(socket, send);
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
      switch (message.type) {
        case "presence.update":
        case "notification.register":
        case "notification.preferences":
        case "notification.snooze": {
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
          try {
            await options.notifications?.connectDevice(device);
          } catch {
            fail("device_unavailable", "Device unavailable", true);
            break;
          }
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
  try {
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
  } catch (error) {
    clearInterval(timer);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  let closing: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${address.port}`,
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
        for (const cleanup of cleanups.values()) cleanup();
        for (const socket of wss.clients) {
          socket.close(1001, "Daemon shutdown");
          socket.terminate();
        }
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return closing;
    },
  };
}
