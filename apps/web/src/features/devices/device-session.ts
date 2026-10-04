import {
  DeviceClient,
  deviceTransport,
  type AuthenticatedChannelOptions,
  type DeviceClientSnapshot,
  type DeviceTransport,
} from "@ace/client/devices";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonEndpoint } from "@/boot/connection.tsx";

type PortableSocket = ReturnType<AuthenticatedChannelOptions["socket"]>;

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** The browser's WebSocket as the portable socket the devices channel speaks through. */
function browserSocket(address: string): PortableSocket {
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
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) =>
      socket.addEventListener(type, (event) =>
        listener({ data: event instanceof MessageEvent ? event.data : undefined }),
      ),
    // The channel only sends JSON text; a binary frame is copied so it owns its buffer.
    send: (data) => socket.send(typeof data === "string" ? data : new Uint8Array(data)),
    close: () => socket.close(),
  };
}

/**
 * The dedicated, authenticated devices channel for this endpoint: a socket of its own against a
 * real daemon (frames never share the client's socket), the fake daemon's in memory.
 */
function transportFor(endpoint: DaemonEndpoint): DeviceTransport {
  if (endpoint.kind === "fake") return endpoint.devices();
  const { url, token } = endpoint.target;
  const { deviceId } = endpoint;
  return deviceTransport({
    target: { kind: "local", url },
    deviceId,
    credential: async () => token,
    socket: browserSocket,
    keys: () => {
      throw new Error("Relay targets are not reachable from the web app.");
    },
    schedule,
  });
}

/** The client's snapshot, and whether its channel has closed since it was opened. */
export interface DeviceSessionSnapshot extends DeviceClientSnapshot {
  /** The channel closed (dropped, refused or timed out); only a reconnect opens it again. */
  closed: boolean;
}

/** A DeviceClient's snapshot as a stable external store (getSnapshot builds a new object). */
export interface DeviceSession {
  readonly client: DeviceClient;
  subscribe(listener: () => void): () => void;
  get(): DeviceSessionSnapshot;
  close(): void;
}

function openSession(endpoint: DaemonEndpoint): DeviceSession {
  const client = new DeviceClient({ id: () => crypto.randomUUID(), schedule });
  const listeners = new Set<() => void>();
  let opening = true;
  let snapshot: DeviceSessionSnapshot = { ...client.getSnapshot(), closed: false };
  const stop = client.watch((next) => {
    // `connect` itself reports a disconnected client first; later, disconnected means closed.
    snapshot = { ...next, closed: !opening && !next.connected };
    for (const listener of listeners) listener();
  });
  client.connect(transportFor(endpoint));
  opening = false;
  return {
    client,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => snapshot,
    close() {
      stop();
      client.disconnect();
    },
  };
}

const offline: DeviceSessionSnapshot = {
  connected: false,
  closed: false,
  devices: [],
  states: [],
  issues: [],
};
const none = () => () => {};

/**
 * One devices channel per daemon endpoint, shared by every view that shows devices (the
 * Devices catalog and each device's tab) and closed when the last of them unmounts. A
 * reconnect replaces it for all of them.
 */
interface Shared {
  session: DeviceSession;
  users: number;
  listeners: Set<() => void>;
}
const shared = new WeakMap<DaemonEndpoint, Shared>();

function acquire(endpoint: DaemonEndpoint): Shared {
  let entry = shared.get(endpoint);
  if (!entry) {
    entry = { session: openSession(endpoint), users: 0, listeners: new Set() };
    shared.set(endpoint, entry);
  }
  entry.users++;
  return entry;
}

function release(endpoint: DaemonEndpoint, entry: Shared) {
  entry.users--;
  if (entry.users > 0) return;
  entry.session.close();
  if (shared.get(endpoint) === entry) shared.delete(endpoint);
}

function reopen(endpoint: DaemonEndpoint) {
  const entry = shared.get(endpoint);
  if (!entry) return;
  entry.session.close();
  entry.session = openSession(endpoint);
  for (const listener of entry.listeners) listener();
}

/**
 * The devices channel while a devices view is open; `reconnect` opens a fresh one for every
 * view. Nothing is replayed: control and approval are asked for again after a reconnect.
 */
export function useDeviceSession(endpoint: DaemonEndpoint | undefined) {
  const [session, setSession] = useState<DeviceSession | undefined>();
  useEffect(() => {
    if (!endpoint) return;
    const entry = acquire(endpoint);
    const follow = () => setSession(entry.session);
    entry.listeners.add(follow);
    follow();
    return () => {
      entry.listeners.delete(follow);
      release(endpoint, entry);
      setSession(undefined);
    };
  }, [endpoint]);
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? none,
    session?.get ?? (() => offline),
    session?.get ?? (() => offline),
  );
  const reconnect = () => {
    if (endpoint) reopen(endpoint);
  };
  return { session, snapshot, reconnect };
}
