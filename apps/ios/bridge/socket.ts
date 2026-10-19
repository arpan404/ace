import type { Transport, TransportEvents } from "@ace/client";
import { host } from "./host.ts";
import type { TrustMonitor } from "./access.ts";

const sockets = new Map<string, { events: TransportEvents; trust: TrustMonitor | undefined }>();

/** A native pinned socket. Swift validates WSS, the pin and redirects before the SDK sees `open`. */
export function nativeTransport(trust?: TrustMonitor): Transport {
  const id = host.uuid();
  return {
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
  else if (type === "trust") socket.trust?.report(value);
  else if (type === "close") {
    sockets.delete(id);
    socket.events.close(Number(value));
  }
}
