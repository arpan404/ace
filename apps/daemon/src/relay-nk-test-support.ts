import { randomUUID } from "node:crypto";
import { Client, relayRoute, type PortableSocket } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { DeviceId } from "@ace/protocol";

// The real client on a relay route, for the NK process tests (ADR 0155): its sockets record
// what they send, so a test can tell which handshake each dial opened with.

/** Client sockets, each with the sizes of the binary frames it sent. */
export function recordedSockets() {
  const dials: { sent: number[]; close(): void }[] = [];
  const socket = (url: string, protocols?: string[]): PortableSocket => {
    const real = browserDeviceSocket(url, protocols);
    const dial = { sent: [] as number[], close: () => real.close() };
    dials.push(dial);
    return {
      get binaryType() {
        return real.binaryType;
      },
      set binaryType(value: string) {
        real.binaryType = value;
      },
      get bufferedAmount() {
        return real.bufferedAmount;
      },
      get protocol() {
        return real.protocol ?? "";
      },
      addEventListener: real.addEventListener.bind(real),
      send(data: string | Uint8Array) {
        dial.sent.push(typeof data === "string" ? data.length : data.length);
        real.send(data);
      },
      close: () => real.close(),
    };
  };
  /** Which handshake each dial opened with: an XX first message is exactly 32 bytes. */
  const patterns = () => dials.map((dial) => (dial.sent[0] === 32 ? "xx" : "nk"));
  return { socket, dials, patterns, drop: () => dials.at(-1)?.close() };
}

export function newClient(
  cleanup: (() => unknown)[],
  relayUrl: string,
  hostId: string,
  device: { id: string; token: string },
  socket: (url: string, protocols?: string[]) => PortableSocket,
) {
  const route = relayRoute({
    relayUrl,
    hostId,
    credential: async () => device.token,
    socket,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  let bound: string | null = null;
  const client = new Client({
    monotonic: () => performance.now(),
    deviceId: DeviceId.parse(device.id),
    storage: {
      load: async () => null,
      save: async () => {},
      hostBinding: {
        load: async () => bound,
        save: async (host: string) => {
          bound = host;
        },
      },
    },
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    limits: { retryBaseMs: 1, retryCapMs: 1 },
    random: () => 0.5,
    id: randomUUID,
    now: Date.now,
    transport: route.transport,
    credential: route.credential,
  });
  cleanup.push(() => client.close());
  return client;
}

export function ready(client: Client, after = 0, attempts = () => 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const state = client.connectionState();
    const timer = setTimeout(() => reject(new Error("Not ready in time")), 15_000);
    const check = () => {
      if (state.getSnapshot() !== "ready" || attempts() <= after) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = state.subscribe(check);
    check();
  });
}

