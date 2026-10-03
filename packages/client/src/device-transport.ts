import { ClientMessage, ServerMessage, type ServerMessage as ServerFrame } from "@ace/protocol";
import {
  connectPortableRelay,
  type PortableRelay,
  type PortableRelayOptions,
  type PortableSocket,
} from "./portable-relay.ts";
import type { Credential } from "./credentials.ts";
import type { DeviceTransport } from "@ace/devices/client";

export type DeviceConnectionTarget =
  | { kind: "local"; url: string }
  | { kind: "relay"; url: string; pinnedFingerprint: string };
export interface AuthenticatedChannelOptions {
  target: DeviceConnectionTarget;
  deviceId: string;
  credential(): Promise<Credential>;
  socket(url: string): PortableSocket;
  keys: PortableRelayOptions["keys"];
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface ChannelEvents {
  ready(): void;
  message(message: ServerFrame | Uint8Array): void | Promise<void>;
  close(): void;
}
export interface AuthenticatedChannel {
  open(events: ChannelEvents): void;
  send(message: ClientMessage): Promise<void>;
  close(): void;
}

/** One authenticated channel per feature. No input queue, replay or token in a URL. */
export function authenticatedChannel(
  options: AuthenticatedChannelOptions,
  kind: "devices" | "files",
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
  const close = () => {
    epoch++;
    ready = false;
    cancelDeadline?.();
    cancelPing?.();
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
      ready = true;
      awaitingPong = false;
      cancelDeadline?.();
      events?.ready();
      heartbeat();
    } else if (!(frame instanceof Uint8Array) && frame.type === "pong") awaitingPong = false;
    else await events?.message(frame);
  };
  return {
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
          opened.addEventListener("close", fail);
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
}
export function deviceTransport(options: AuthenticatedChannelOptions): DeviceTransport {
  const channel = authenticatedChannel(options, "devices");
  return {
    open: (events) => channel.open(events),
    send: (message) => channel.send(message),
    close: () => channel.close(),
  };
}
