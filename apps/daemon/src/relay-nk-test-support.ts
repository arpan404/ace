import { randomUUID } from "node:crypto";
import { Client, relayRoute, type PortableSocket } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { DeviceId } from "@ace/protocol";

// The real client on a relay route, for the NK process tests (ADR 0155): its sockets record
// what they send, so a test can tell which handshake each dial opened with.

/**
 * Which handshake a dial opened with: what the relay took from its upgrade request (`ace.v3` NK,
 * `ace.v2` XX), else its first frame (an XX first message is exactly 32 bytes).
 */
function handshake(dial: { sent: number[]; protocol?: string }): "xx" | "nk" {
  if (dial.protocol === "ace.v3") return "nk";
  if (dial.protocol === "ace.v2") return "xx";
  return dial.sent[0] === 32 ? "xx" : "nk";
}

/**
 * Client sockets, each with the sizes of the binary frames it sent. With `holdConfirm`, an NK
 * dial's confirmation (its second frame) and what follows wait until `confirm()`.
 */
export function recordedSockets(options: { holdConfirm?: boolean } = {}) {
  const dials: { sent: number[]; protocol?: string; close(): void }[] = [];
  const held: (() => void)[] = [];
  let gated = options.holdConfirm === true;
  const socket = (url: string, protocols?: string[]): PortableSocket => {
    const real = browserDeviceSocket(url, protocols);
    const dial: { sent: number[]; protocol?: string; close(): void } = {
      sent: [],
      close: () => real.close(),
    };
    real.addEventListener("open", () => (dial.protocol = real.protocol ?? ""));
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
        const nk = handshake(dial) === "nk";
        // The confirmation is an NK dial's first frame when the relay took its first message
        // from the upgrade (`ace.v3`), its second otherwise.
        const confirmAt = dial.protocol === "ace.v3" ? 0 : 1;
        if (gated && nk && (dial.sent.length - 1 >= confirmAt || held.length))
          held.push(() => real.send(data));
        else real.send(data);
      },
      close: () => real.close(),
    };
  };
  const patterns = () => dials.map(handshake);
  /** Lets the held confirmation, and everything after it, go. */
  const confirm = () => {
    gated = false;
    for (const send of held.splice(0)) send();
  };
  return { socket, dials, patterns, confirm, drop: () => dials.at(-1)?.close() };
}

export function newClient(
  cleanup: (() => unknown)[],
  relayUrl: string,
  hostId: string,
  device: { id: string; token: string },
  socket: (url: string, protocols?: string[]) => PortableSocket,
  /** Called each time the connection asks the route for a new transport (a new attempt). */
  onAttempt?: () => void,
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
    transport: () => {
      onAttempt?.();
      return route.transport();
    },
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
