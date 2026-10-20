import { browserCredential } from "@/boot/remote-credential.ts";
import { AccessClient } from "@ace/client";
import {
  DeviceClient,
  type DeviceConnection,
  deviceTransport,
  browserDeviceSocket,
  ephemeralRelayKeys,
  failoverTransport,
  type DeviceClientSnapshot,
  type DeviceTransport,
} from "@ace/client/devices";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonEndpoint } from "@/boot/connection.tsx";
import { webStorage } from "@/boot/web-storage.ts";
import { learnRelay, type RelayRoute } from "./relay-route.ts";

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

const loopback = (url: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

/** The daemon's HTTP origin for its socket address. */
const httpOrigin = (url: string) => {
  const origin = new URL(url);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return `${origin.origin}/`;
};

/**
 * The dedicated, authenticated devices channel for this endpoint: a socket of its own against a
 * real daemon (frames never share the client's socket), the fake daemon's in memory. A paired
 * daemon elsewhere is tried at its own address first and, when that won't open, through its
 * end-to-end encrypted relay (`routed` says which one carries it).
 */
function transportFor(
  endpoint: DaemonEndpoint,
  routed: (route: DeviceConnection) => void,
): DeviceTransport {
  if (endpoint.kind === "fake") return endpoint.devices();
  const { target, deviceId } = endpoint;
  const direct = deviceTransport({
    target: { kind: "local", url: target.url },
    deviceId,
    credential: browserCredential(target),
    socket: browserDeviceSocket,
    keys: ephemeralRelayKeys,
    schedule,
  });
  const token = target.token;
  if (loopback(target.url) || !target.pairedDeviceId) return direct;
  const relay = learnRelay(
    webStorage(() => localStorage),
    target.url,
    () =>
      new AccessClient({
        origin: httpOrigin(target.url),
        fetch: (input, init) => fetch(input, init),
        token: async () => token,
      }).remoteStatus(),
  );
  return failoverTransport(
    direct,
    async () => {
      const route: RelayRoute | undefined = await relay;
      return (
        route &&
        deviceTransport({
          target: { kind: "relay", url: route.url, pinnedFingerprint: route.fingerprint },
          expectedHostId: route.hostId,
          deviceId,
          // Inside the encrypted channel the paired token itself; tickets need the address.
          credential: async () => token,
          socket: browserDeviceSocket,
          keys: ephemeralRelayKeys,
          schedule,
        })
      );
    },
    (route) => routed(route === "fallback" ? "relay" : "remote"),
  );
}

/** The client's snapshot, and whether its channel has closed since it was opened. */
export interface DeviceSessionSnapshot extends DeviceClientSnapshot {
  /** The channel closed (dropped, refused or timed out); only a reconnect opens it again. */
  closed: boolean;
}

/** A DeviceClient's snapshot as a stable external store (getSnapshot builds a new object). */
export interface DeviceSession {
  readonly client: DeviceClient;
  readonly connection?: DeviceConnection;
  subscribe(listener: () => void): () => void;
  get(): DeviceSessionSnapshot;
  close(): void;
}

function openSession(endpoint: DaemonEndpoint): DeviceSession {
  const client = new DeviceClient({ id: () => crypto.randomUUID(), schedule });
  const listeners = new Set<() => void>();
  let connection: DeviceConnection =
    endpoint.kind === "fake" || loopback(endpoint.target.url) ? "local" : "remote";
  let opening = true;
  let snapshot: DeviceSessionSnapshot = { ...client.getSnapshot(), closed: false };
  const stop = client.watch((next) => {
    // `connect` itself reports a disconnected client first; later, disconnected means closed.
    snapshot = { ...next, closed: !opening && !next.connected };
    for (const listener of listeners) listener();
  });
  client.connect(
    transportFor(endpoint, (route) => {
      connection = route;
    }),
  );
  opening = false;
  return {
    client,
    /** Which way the channel goes: the stream profile is sized for it. */
    get connection() {
      return connection;
    },
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
  inventoryLoaded: false,
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
