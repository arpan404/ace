import type { Transport, TransportEvents } from "@ace/client";
import { host } from "./host.ts";
import type { TrustMonitor } from "./access.ts";
import type { AuthenticatedChannelOptions } from "@ace/client/devices";
import { hasCapability, type MediaSocketOpen } from "@ace/native-host";

type Early = (text: string) => void;
const sockets = new Map<
  string,
  {
    events: TransportEvents;
    trust: TrustMonitor | undefined;
    early: Early | undefined;
    seen: number;
    /** Binary bytes handed to Swift and not yet sent (`aceSocket(id, "sent", n)`). */
    buffered: number;
  }
>();
/** Messages per socket offered to `early`: the hello's answer comes first. */
const earlyMessages = 3;

/**
 * A native pinned socket. Swift validates WSS, the pin and redirects before the SDK sees `open`.
 * It carries binary messages: browser stream pieces (`ACES`) stay native, where Swift assembles
 * and draws them; any other binary message reaches the SDK as bytes.
 */
export function nativeTransport(trust?: TrustMonitor, early?: Early): Transport {
  return nativeSocket(host.uuid(), "", trust, early);
}

/** A native socket that also sends binary messages, read by pointer (`socketBytes`). */
interface BinaryTransport extends Transport {
  sendBinary(bytes: Uint8Array): void;
  /** Binary bytes sent here that Swift has not sent on yet. */
  readonly bufferedAmount: number;
}

function nativeSocket(
  id: string,
  opening: string,
  trust?: TrustMonitor,
  early?: Early,
): BinaryTransport {
  return {
    supportsBinary: true,
    open(events) {
      sockets.set(id, { events, trust, early, seen: 0, buffered: 0 });
      host.socket(id, "open", opening);
    },
    sendBinary(bytes) {
      const send = host.socketBytes;
      if (!send || !hasCapability(host, "socketBytes"))
        throw new Error("This app can't send binary messages");
      const socket = sockets.get(id);
      if (socket) socket.buffered += bytes.byteLength;
      send.call(host, id, bytes);
    },
    get bufferedAmount() {
      return sockets.get(id)?.buffered ?? 0;
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

/** A media connection's socket: text both ways, plus the one binary hello it opens with. */
export interface MediaSocket extends Transport {
  /** The native socket's id: the path its pictures come by (`media.delivery`). */
  readonly id: string;
  sendBytes(bytes: Uint8Array): void;
}

/**
 * A media connection to ace-media (ADR 0147 §4), opened natively at the `media.connect` address,
 * or through the relay when there is none or the machine is reached that way. Its pictures never
 * enter JavaScriptCore: Swift draws them as it draws the daemon socket's. The welcome and pongs
 * arrive here as text; the hello, acks and pings leave from here.
 */
export function nativeMediaSocket(url: string | undefined): MediaSocket {
  const id = host.uuid();
  const opening: MediaSocketOpen = { media: url === undefined ? {} : { url } };
  return {
    ...nativeSocket(id, JSON.stringify(opening)),
    id,
    sendBytes(bytes) {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      host.socket(id, "bytes", host.latin1Base64(binary, false));
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
  if (type === "sent") {
    socket.buffered = Math.max(0, socket.buffered - Number(value));
    return;
  }
  if (type === "open") socket.events.open();
  else if (type === "message") {
    if (socket.early && socket.seen < earlyMessages) {
      socket.seen++;
      socket.early(value);
    }
    socket.events.message(value);
  } else if (type === "trust") socket.trust?.report(value);
  else if (type === "close") {
    sockets.delete(id);
    // "<code>" or "<code> <reason>": the reason tells the owner's revocation from any other 4003.
    const space = value.indexOf(" ");
    if (space < 0) socket.events.close(Number(value));
    else socket.events.close(Number(value.slice(0, space)), value.slice(space + 1));
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
  const transport = nativeSocket(host.uuid(), "", trust);
  const socket = {
    binaryType: "arraybuffer",
    get bufferedAmount() {
      return transport.bufferedAmount;
    },
    addEventListener(type: string, listener: (event: { data: unknown; code?: number }) => void) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    send(data: string | Uint8Array) {
      // A tunnel's frames are binary (ADR 0194); every other feature channel sends JSON.
      if (typeof data === "string") transport.send(data);
      else transport.sendBinary(data);
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
