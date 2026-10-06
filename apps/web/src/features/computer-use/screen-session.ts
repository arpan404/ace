import {
  ScreenClientError,
  ScreenStreamClient,
  browserScreenSocket,
  screenTransport,
  type ScreenTransport,
} from "@ace/client/screen-stream";
import {
  ScreenGrant,
  ScreenPermissions,
  ScreenStatus,
  type ScreenAgentScope,
  type ScreenState,
  type ScreenOperation,
} from "@ace/protocol";
import { useConnectionState } from "@ace/client-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useDaemonConnection, type DaemonEndpoint } from "@/boot/connection.tsx";

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * The dedicated, authenticated screen channel: a socket of its own against a real daemon (frames
 * never share the client's socket), the fake daemon's in memory.
 */
function transportFor(endpoint: DaemonEndpoint): ScreenTransport {
  if (endpoint.kind === "fake") return endpoint.screen();
  const { url, token } = endpoint.target;
  return screenTransport({
    target: { kind: "local", url },
    deviceId: endpoint.deviceId,
    credential: async () => token,
    socket: browserScreenSocket,
    keys: () => {
      throw new Error("Relay targets are not reachable from the web app.");
    },
    schedule,
  });
}

export interface ScreenSnapshot {
  connected: boolean;
  /** The channel closed since it opened; a reconnect opens a new one. */
  closed: boolean;
  /** Computer use is on (undefined until the daemon has said). */
  enabled: boolean | undefined;
  /** macOS grants to Ace Screen Helper, as last read. */
  permissions: ScreenPermissions | undefined;
  /** Why the last read of those grants failed; a read that succeeds clears it. */
  permissionsProblem: { code: string | undefined; message: string } | undefined;
  /** The daemon has no screen helper here (another OS, or none installed). */
  unavailable: boolean;
  states: readonly ScreenState[];
}

export interface ScreenSession {
  subscribe(listener: () => void): () => void;
  get(): ScreenSnapshot;
  /** Read enablement, permissions and the session list again (after a reconnect). */
  refresh(): Promise<void>;
  request(operation: ScreenOperation, timeoutMs?: number): Promise<unknown>;
  grants(threadId?: string): Promise<ScreenGrant[]>;
  /** The agent that held a session before you took it over, to hand it back to. */
  lastHolder(sessionId: string): ScreenAgentScope | undefined;
  watchFrames: ScreenStreamClient["watchFrames"];
  /** Hold a session's live stream for one view; views of one session share it. */
  retainStream: ScreenStreamClient["retainStream"];
  close(): void;
}

const offline: ScreenSnapshot = {
  connected: false,
  closed: false,
  enabled: undefined,
  permissions: undefined,
  permissionsProblem: undefined,
  unavailable: false,
  states: [],
};

function openSession(endpoint: DaemonEndpoint): ScreenSession {
  const client = new ScreenStreamClient({ id: () => crypto.randomUUID(), schedule });
  const listeners = new Set<() => void>();
  const holders = new Map<string, ScreenAgentScope>();
  let opening = true;
  let wasConnected = false;
  let permissions: ScreenPermissions | undefined;
  let permissionsProblem: ScreenSnapshot["permissionsProblem"];
  let unavailable = false;
  let snapshot: ScreenSnapshot = offline;
  const publish = () => {
    const next = client.getSnapshot();
    for (const state of next.states)
      if (state.controller === "agent" && state.holder) holders.set(state.sessionId, state.holder);
    snapshot = {
      connected: next.connected,
      closed: !opening && !next.connected,
      enabled: next.enabled,
      permissions,
      permissionsProblem,
      unavailable,
      states: next.states,
    };
    for (const listener of listeners) listener();
  };
  /** A read of the grants ended: what they are, or why they couldn't be read. */
  const readPermissions = (result: { value: ScreenPermissions } | { error: unknown }) => {
    if ("value" in result) {
      permissions = result.value;
      permissionsProblem = undefined;
    } else {
      const error = result.error;
      permissionsProblem = {
        code: error instanceof ScreenClientError ? error.errorCode : undefined,
        message: error instanceof Error ? error.message : "Couldn't read permissions",
      };
    }
    publish();
  };
  const refresh = async () => {
    try {
      const status = ScreenStatus.parse(await client.request({ op: "status" }));
      unavailable = false;
      readPermissions({ value: status.permissions });
    } catch (error) {
      // No helper on this daemon: nothing here can work, say so once.
      if (error instanceof ScreenClientError && error.errorCode === "screen_disabled")
        unavailable = true;
      // Anything else leaves the grants unknown: say why rather than check forever.
      else readPermissions({ error });
    }
    // Publish status even when session enumeration fails on an unavailable daemon.
    publish();
    await client.request({ op: "sessions" });
    publish();
  };
  let wasEnabled: boolean | undefined;
  const stop = client.watch(() => {
    const { connected, enabled } = client.getSnapshot();
    const arrived = connected && !wasConnected;
    // Turned on while the grants couldn't be read (it was off): read them now.
    const switchedOn =
      enabled === true && wasEnabled !== true && (!permissions || !!permissionsProblem);
    wasConnected = connected;
    wasEnabled = enabled;
    publish();
    // Each time the channel comes up: what's on, what's granted and which sessions run.
    if (arrived) void refresh().catch(() => {});
    else if (switchedOn)
      void client.request({ op: "permissions" }).then(
        (result) => {
          const parsed = ScreenPermissions.safeParse(result);
          if (parsed.success) readPermissions({ value: parsed.data });
        },
        (error: unknown) => readPermissions({ error }),
      );
  });
  client.connect(transportFor(endpoint));
  opening = false;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => snapshot,
    refresh,
    async request(operation, timeoutMs) {
      const reads = operation.op === "permissions.request" || operation.op === "permissions";
      let result: unknown;
      try {
        result = await client.request(operation, timeoutMs ? { timeoutMs } : {});
      } catch (error) {
        if (reads) readPermissions({ error });
        throw error;
      }
      if (reads) {
        const parsed = ScreenPermissions.safeParse(result);
        readPermissions(
          parsed.success
            ? { value: parsed.data }
            : { error: new Error("The daemon answered something unexpected.") },
        );
      }
      return result;
    },
    async grants(threadId) {
      return ScreenGrant.array()
        .max(256)
        .parse(await client.request({ op: "approvals", ...(threadId ? { threadId } : {}) }));
    },
    lastHolder: (sessionId) => holders.get(sessionId),
    watchFrames: (sessionId, listener) => client.watchFrames(sessionId, listener),
    retainStream: (sessionId) => client.retainStream(sessionId),
    close() {
      stop();
      client.disconnect();
    },
  };
}

interface Shared {
  session: ScreenSession;
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

const none = () => () => {};

/**
 * The screen channel while anything shows computer use: one per daemon endpoint, shared by the
 * rail's indicator, Settings and a thread's panel, closed when the last of them leaves. When the
 * daemon connection comes back, a closed channel opens again for all of them. Nothing is
 * replayed: control, subscriptions and approvals are asked for again.
 */
export function useScreenSession() {
  const { endpoint } = useDaemonConnection();
  const [session, setSession] = useState<ScreenSession | undefined>();
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
  const ready = useConnectionState() === "ready";
  const closed = snapshot.closed;
  useEffect(() => {
    if (ready && closed && endpoint) reopen(endpoint);
  }, [ready, closed, endpoint]);
  return { session, snapshot, reconnect: () => endpoint && reopen(endpoint) };
}

export { ScreenClientError };
