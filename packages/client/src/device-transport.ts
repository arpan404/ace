/// <reference lib="dom" />
import { z } from "zod";
import { ClientMessage, ServerMessage, type ServerMessage as ServerFrame } from "@ace/protocol";
import type { PortableRelay, PortableRelayOptions, PortableSocket } from "./portable-relay.ts";
import type { Credential } from "./credentials.ts";
import { DeviceClientError, type DeviceTransport } from "@ace/devices/client";

export type DeviceConnectionTarget =
  | { kind: "local"; url: string }
  | { kind: "relay"; url: string; pinnedFingerprint: string };
export interface AuthenticatedChannelOptions {
  target: DeviceConnectionTarget;
  deviceId: string;
  credential(): Promise<Credential>;
  /** Forward native close events, including their code, so 4013 can back off. */
  socket(url: string): PortableSocket;
  keys: PortableRelayOptions["keys"];
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface ChannelEvents {
  ready(): void;
  message(message: ServerFrame | Uint8Array): void | Promise<void>;
  close(): void;
  limited?(error: DeviceClientError): void;
}
export interface AuthenticatedChannel {
  open(events: ChannelEvents): void;
  send(message: ClientMessage): Promise<void>;
  close(): void;
}

/** One authenticated channel per feature. No input queue, replay or token in a URL. */
export function authenticatedChannel(
  options: AuthenticatedChannelOptions,
  kind: "devices" | "files" | "screen",
): AuthenticatedChannel {
  let socket: PortableSocket | undefined;
  let relay: PortableRelay | undefined;
  let events: ChannelEvents | undefined;
  let ready = false;
  let epoch = 0;
  let cancelDeadline: (() => void) | undefined;
  let cancelPing: (() => void) | undefined;
  let awaitingPong = false;
  let controller: AbortController | undefined;
  let cancelRetry: (() => void) | undefined;
  let limitAttempts = 0;
  const close = () => {
    epoch++;
    ready = false;
    cancelDeadline?.();
    cancelPing?.();
    cancelRetry?.();
    cancelRetry = undefined;
    controller?.abort();
    const prior = events;
    events = undefined;
    socket?.close();
    relay?.close();
    socket = undefined;
    relay = undefined;
    prior?.close();
  };
  const sendWire = async (message: ClientMessage) => {
    if (relay) await relay.send(message);
    else if (socket) {
      const text = JSON.stringify(ClientMessage.parse(message));
      if (text.length > 256 * 1024 || socket.bufferedAmount + text.length > 1024 * 1024)
        throw new Error("Device request queue limit");
      socket.send(text);
    } else throw new Error("Device channel disconnected");
  };
  const heartbeat = () => {
    cancelPing = options.schedule(() => {
      if (!ready) return;
      if (awaitingPong) {
        close();
        return;
      }
      awaitingPong = true;
      void sendWire({ type: "ping" }).then(heartbeat).catch(close);
    }, 15000);
  };
  const receive = async (frame: ServerFrame | Uint8Array, stamp: number) => {
    if (epoch !== stamp) return;
    if (!ready) {
      if (frame instanceof Uint8Array || frame.type !== "welcome")
        throw new Error("Authenticated welcome required");
      if (options.target.kind === "relay" && frame.hostId !== options.target.pinnedFingerprint)
        throw new Error("Unexpected relay host");
      limitAttempts = 0;
      ready = true;
      awaitingPong = false;
      cancelDeadline?.();
      events?.ready();
      heartbeat();
    } else if (!(frame instanceof Uint8Array) && frame.type === "pong") awaitingPong = false;
    else await events?.message(frame);
  };
  const channel: AuthenticatedChannel = {
    open(next) {
      close();
      events = next;
      const stamp = ++epoch;
      const fail = () => {
        if (epoch === stamp) close();
      };
      cancelDeadline = options.schedule(fail, 20000);
      controller = new AbortController();
      const signal = controller.signal;
      void (async () => {
        const credential = await options.credential();
        if (epoch !== stamp) return;
        const hello = ClientMessage.parse({
          type: "hello",
          protocolVersion: 1,
          deviceId: options.deviceId,
          ...(typeof credential === "string" ? { token: credential } : credential),
          channel: kind,
        });
        if (options.target.kind === "relay") {
          // The relay's Noise handshake and ciphers load only for relay targets, so a local
          // channel (the web app's only kind) never fetches them.
          const { connectPortableRelay } = await import("./portable-relay.ts");
          if (epoch !== stamp) return;
          const opened = await connectPortableRelay({
            relayUrl: options.target.url,
            pinnedFingerprint: options.target.pinnedFingerprint,
            socket: options.socket,
            keys: options.keys,
            schedule: options.schedule,
            signal,
          });
          if (epoch !== stamp) {
            opened.close();
            return;
          }
          relay = opened;
          await opened.send(hello);
          while (!signal.aborted) await receive(await opened.receive(), stamp);
        } else {
          const opened = options.socket(options.target.url);
          opened.binaryType = "arraybuffer";
          socket = opened;
          let inbound = Promise.resolve();
          let pending = 0;
          let queued = 0;
          opened.addEventListener("open", () => {
            if (epoch === stamp) void sendWire(hello).catch(fail);
          });
          opened.addEventListener("close", (...args: unknown[]) => {
            const event = z.object({ code: z.number().int() }).safeParse(args[0]);
            const code = event.success ? event.data.code : 1006;
            if (epoch !== stamp) return;
            if (code !== 4013) {
              fail();
              return;
            }
            const waitingEvents = events;
            events = undefined;
            close();
            if (!waitingEvents) return;
            events = waitingEvents;
            const waiting = epoch;
            waitingEvents.limited?.(
              new DeviceClientError(
                "limit",
                "Device state subscriber capacity reached",
                "Retrying with backoff; close another main or devices channel to release a slot.",
              ),
            );
            if (epoch === waiting)
              cancelRetry = options.schedule(
                () => {
                  cancelRetry = undefined;
                  if (epoch === waiting) {
                    // A capacity retry retains the consumer and its transport lease.
                    events = undefined;
                    channel.open(waitingEvents);
                  }
                },
                Math.min(30000, 5000 * 2 ** Math.min(limitAttempts++, 3)),
              );
          });
          opened.addEventListener("error", fail);
          opened.addEventListener("message", ({ data }) => {
            if (epoch !== stamp) return;
            const bytes =
              typeof data === "string"
                ? data.length * 2
                : data instanceof ArrayBuffer
                  ? data.byteLength
                  : data instanceof Uint8Array
                    ? data.byteLength
                    : 0;
            if (
              !bytes ||
              bytes > 8 * 1024 * 1024 + 4096 ||
              queued + bytes > 16 * 1024 * 1024 ||
              pending >= 32
            ) {
              fail();
              return;
            }
            pending++;
            queued += bytes;
            inbound = inbound
              .then(async () => {
                if (epoch !== stamp) return;
                const frame =
                  data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : data instanceof Uint8Array
                      ? data
                      : ServerMessage.parse(JSON.parse(typeof data === "string" ? data : "null"));
                await receive(frame, stamp);
              })
              .catch(fail)
              .finally(() => {
                pending--;
                queued -= bytes;
              });
          });
        }
      })().catch(fail);
    },
    async send(message) {
      if (!ready) throw new Error("Device channel is not authenticated");
      await sendWire(message);
    },
    close,
  };
  return channel;
}
export function deviceTransport(options: AuthenticatedChannelOptions): DeviceTransport {
  const channel = authenticatedChannel(options, "devices");
  return {
    open: (events) => channel.open(events),
    send: (message) => channel.send(message),
    close: () => channel.close(),
  };
}

/** Browser socket boundary shared by the app and device latency probe. */
export function browserDeviceSocket(address: string): PortableSocket {
  const socket = new WebSocket(address);
  return {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(type: string) {
      socket.binaryType = type === "blob" ? "blob" : "arraybuffer";
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    addEventListener: (type, listener) =>
      socket.addEventListener(type, (event) =>
        listener({
          data: event instanceof MessageEvent ? event.data : undefined,
          ...(event instanceof CloseEvent ? { code: event.code } : {}),
        }),
      ),
    send: (data) => socket.send(typeof data === "string" ? data : new Uint8Array(data)),
    close: () => socket.close(),
  };
}
