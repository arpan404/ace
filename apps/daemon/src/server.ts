import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, HostId, type DeviceId, type ServerMessage } from "@ace/protocol";
import {
  PluginClientMessage,
  PluginResponse,
  type PluginServerMessage,
} from "@ace/protocol/plugins";
import { commandContext, type CommandHandler } from "./commands.ts";
import { validToken } from "./local-files.ts";
import { defaultPressure, Outbox, type PressureOptions } from "./outbox.ts";
import type { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";

export interface ServerOptions {
  port: number;
  token: string;
  hostId: string;
  store: Store;
  handler: CommandHandler;
  plugins?: { handle(input: unknown): Promise<PluginResponse> };
  replayLimit?: number;
  idleTimeoutMs?: number;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
export async function startServer(
  options: ServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const hostId = HostId.parse(options.hostId);
  if (!/^[0-9a-f]{64}$/.test(options.token)) throw new Error("Invalid server token");
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    maxPayload: 1024 * 1024,
  });
  const pluginTasks = new Set<Promise<void>>();
  const cleanups = new Map<WebSocket, () => void>();
  const ticks = new Map<WebSocket, () => void>();
  wss.on("connection", (socket) => {
    let device: DeviceId | undefined;
    let pluginPending = false;
    let lastActivity = Date.now();
    const subscriptions = new Map<string, () => void>();
    const outbox = new Outbox(socket, { ...defaultPressure, ...options.pressure });
    const send = (message: ServerMessage | PluginServerMessage) => outbox.send(message);
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
    socket.on("message", (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      lastActivity = Date.now();
      let message: ClientMessage | PluginClientMessage;
      try {
        if (binary) throw new Error("Text required");
        const input: unknown = JSON.parse(data.toString());
        const standard = ClientMessage.safeParse(input);
        message = standard.success ? standard.data : PluginClientMessage.parse(input);
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
        device = message.deviceId;
        send({
          type: "welcome",
          hostId,
          protocolVersion: 1,
          headSeq: options.store.headSeq(),
        });
        return;
      }
      switch (message.type) {
        case "pluginRequest": {
          if (!options.plugins) {
            fail("plugins_unavailable", "Plugin service unavailable");
            break;
          }
          if (pluginPending || pluginTasks.size >= 8) {
            fail("plugins_busy", "Plugin operation already pending");
            break;
          }
          pluginPending = true;
          const service = options.plugins;
          const request = message;
          const task = (async () => {
            try {
              const response = PluginResponse.parse(await service.handle(request.request));
              const result: PluginServerMessage = {
                type: "pluginResult",
                requestId: request.requestId,
                response,
              };
              if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
                throw new Error("Plugin response exceeds wire limit");
              send(result);
            } catch (error) {
              options.log?.(error);
              fail(
                "plugin_failed",
                error instanceof Error ? error.message.slice(0, 8192) : "Plugin operation failed",
              );
            } finally {
              pluginPending = false;
            }
          })();
          pluginTasks.add(task);
          void task.finally(() => pluginTasks.delete(task));
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
    });
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
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(timer);
        for (const cleanup of cleanups.values()) cleanup();
        for (const socket of wss.clients) {
          socket.close(1001, "Daemon shutdown");
          socket.terminate();
        }
        wss.close((error) => {
          void Promise.allSettled(pluginTasks).then(() => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
      return closing;
    },
  };
}
