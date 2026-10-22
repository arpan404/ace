import type { Transport, TransportEvents } from "@ace/client";
import { host } from "./host.ts";
import type { TrustMonitor } from "./access.ts";
import type { AuthenticatedChannelOptions } from "@ace/client/devices";

const sockets = new Map<string, { events: TransportEvents; trust: TrustMonitor | undefined }>();

/**
 * A native pinned socket. Swift validates WSS, the pin and redirects before the SDK sees `open`.
 * It carries binary messages: browser stream pieces (`ACES`) stay native, where Swift assembles
 * and draws them; any other binary message reaches the SDK as bytes.
 */
export function nativeTransport(trust?: TrustMonitor): Transport {
  const id = host.uuid();
  return {
    supportsBinary: true,
    open(events) {
      sockets.set(id, { events, trust });
      host.socket(id, "open", "");
    },
    send(text) {
      host.socket(id, "send", text);
    },
    close() {
      sockets.delete(id);
      host.socket(id, "close", "");
    },
  };
}

/**
 * Native socket callbacks, delivered on the JavaScriptCore run loop. Binary messages arrive as a
 * Uint8Array Swift filled; everything else as text.
 */
export function socketEvent(id: string, type: string, value: string | Uint8Array): void {
  const socket = sockets.get(id);
  if (!socket) return;
  if (typeof value !== "string") {
    if (type === "binary") socket.events.binary?.(value);
    return;
  }
  if (type === "open") socket.events.open();
  else if (type === "message") socket.events.message(value);
  else if (type === "trust") socket.trust?.report(value);
  else if (type === "close") {
    sockets.delete(id);
    socket.events.close(Number(value));
  }
}

/** Adapt the same pinned native transport to the SDK's dedicated feature channels. */
export const nativePortableSocket: (
  trust: TrustMonitor,
) => ReturnType<AuthenticatedChannelOptions["socket"]> = (trust) => {
  const listeners = new Map<string, ((event: { data: unknown; code?: number }) => void)[]>();
  const emit = (type: string, event: { data: unknown; code?: number } = { data: null }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const transport = nativeTransport(trust);
  const socket = {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    addEventListener(type: string, listener: (event: { data: unknown; code?: number }) => void) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    send(data: string | Uint8Array) {
      if (typeof data !== "string") throw new Error("Native feature channels send JSON only");
      transport.send(data);
    },
    close: () => transport.close(),
  };
  transport.open({
    open: () => emit("open"),
    message: (data) => emit("message", { data }),
    binary: (data) => emit("message", { data }),
    close: (code) => emit("close", { data: null, code }),
  });
  return socket;
};
