import { FakeDaemon, ScenarioPlayer, devWorld, fakeTransport } from "@ace/fake-daemon";
import type { Client } from "@ace/client";
import { createBrowserClient, memoryStorage } from "./client.ts";
import { fallback, type DaemonConnection } from "./connection.tsx";

const timer = {
  set(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/** A thread the reader "left" partway through, so its transcript shows a New activity divider. */
export interface SeenSeed {
  threadId: string;
  itemId: string;
}

/** `bun run --filter @ace/web dev:fake`: the whole app against scripted scenarios in-page. */
export function bootFake(): {
  client: Client;
  daemon: FakeDaemon;
  /** The fake daemon's access routes and devices, for the connection context. */
  connection: DaemonConnection;
  seen: SeenSeed[];
  /** The name the design's account disc shows ("AB"), used when this device has none yet. */
  profileName: string;
} {
  const daemon = new FakeDaemon({ clock: () => Date.now(), snapshotItems: 40 });
  // Every thread is stamped back by its age; live ones keep moving while the app is open.
  for (const thread of devWorld()) {
    const player = new ScenarioPlayer(daemon, thread.scenario, { agoMs: thread.agoMs });
    if (thread.through) player.runThrough(thread.through);
    else if (!thread.live) player.runUntilBlocked();
    if (thread.live) player.autoplay(timer, thread.live.speed);
  }
  const client = createBrowserClient({
    deviceId: "web-fake-device",
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
  });
  // The hero thread was last read before reconnect-audit's finding arrived.
  const relay = daemon.itemId("thread-dedupe", "relay");
  const seen = relay ? [{ threadId: "thread-dedupe", itemId: relay }] : [];
  // Exposed for poking at fault injection from the console, e.g. ace.daemon.disconnectAll().
  // In Electron `window.ace` is the read-only desktop bridge, so use `aceFake` there.
  Object.assign(globalThis, { ["ace" in globalThis ? "aceFake" : "ace"]: { daemon, client } });
  return {
    client,
    daemon,
    connection: fakeConnection(daemon),
    seen,
    profileName: "Arpan Bhandari",
  };
}

/** The connection dev:fake and tests run on: the fake daemon's access routes and devices. */
export function fakeConnection(daemon: FakeDaemon): DaemonConnection {
  return {
    ...fallback,
    endpoint: {
      kind: "fake",
      access: {
        origin: "http://127.0.0.1:4242/",
        fetch: daemon.access.fetch,
        token: async () => daemon.access.token,
      },
      devices: () => daemon.appDevices.transport(),
    },
  };
}
