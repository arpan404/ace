import type { Transport, TransportEvents } from "@ace/client";
import { host } from "./host.ts";
import type { TrustMonitor } from "./access.ts";

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

/** Native socket callbacks, delivered on the JavaScriptCore run loop. */
export function socketEvent(id: string, type: string, value: string): void {
  const socket = sockets.get(id);
  if (!socket) return;
  if (type === "open") socket.events.open();
  else if (type === "message") socket.events.message(value);
  else if (type === "binary") socket.events.binary?.(latin1Bytes(host.base64(value, true)));
  else if (type === "trust") socket.trust?.report(value);
  else if (type === "close") {
    sockets.delete(id);
    socket.events.close(Number(value));
  }
}

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}
