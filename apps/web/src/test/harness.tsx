import { Client, type ClientApi } from "@ace/client";
import { ClientHost, RemoteClient } from "@ace/client-worker";
import { FakeDaemon, ScenarioPlayer, fakeTransport, type Scenario } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { afterEach } from "vitest";
import { App, AppFrame, createQueryClient } from "@/app.tsx";
import { memoryStorage } from "@/boot/client.ts";
import { fakeMachinePool } from "@/boot/fake-machines.ts";

type ClientStorage = ReturnType<typeof memoryStorage>;
import { DaemonConnectionContext } from "@/boot/connection.tsx";
import { fakeConnection } from "@/boot/fake.ts";
import { preloadDeferred } from "@/features/thread/index.ts";
import { type KeyValueStorage } from "@ace/ui-core";

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((client) => client.close()));
});

/** In-memory Web Storage, so persistence is observable across remounts within a test. */
export function memoryKeyValue(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** A @ace/client wired to a FakeDaemon speaking the wire protocol in memory. */
export function fakeClient(
  daemon: FakeDaemon,
  token = daemon.token,
  outbox: ClientStorage = memoryStorage(),
): Client {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => token,
    storage: outbox,
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
    limits: { retryBaseMs: 2, retryCapMs: 10 },
  });
  running.push(client);
  return client;
}

/** The real app, a real @ace/client and a FakeDaemon speaking the wire protocol in memory. */
export function harness(
  options: {
    snapshotItems?: number;
    storage?: KeyValueStorage;
    matchMedia?: (query: string) => MediaQueryList;
    /** Run the client the way a browser with workers does: behind a ClientHost and a port. */
    throughWorker?: boolean;
    /** The daemon's clock; by default a counter from 1,000 ms. */
    clock?: () => number;
    /** When each stage of a project clone runs, on every machine (tests step clones by hand). */
    projectScheduler?: (callback: () => void) => void;
    /** Where the client keeps its outbox (tests hold a save to catch work done meanwhile). */
    outbox?: ClientStorage;
    /**
     * Other machines in the window's machine pool (ADR 0059), each a fake daemon of its own.
     * This daemon is then "This Mac".
     */
    machines?: readonly { hostId: string; name: string }[];
  } = {},
) {
  let now = 1_000;
  const clock = options.clock ?? (() => (now += 1));
  const others = (options.machines ?? []).map(
    (machine) =>
      new FakeDaemon({
        clock,
        hostId: machine.hostId,
        displayName: machine.name,
        ...(options.projectScheduler ? { projectScheduler: options.projectScheduler } : {}),
      }),
  );
  const daemon = new FakeDaemon({
    clock,
    ...(others.length ? { hostId: "this-mac", displayName: "This Mac" } : {}),
    ...(options.snapshotItems ? { snapshotItems: options.snapshotItems } : {}),
    ...(options.projectScheduler ? { projectScheduler: options.projectScheduler } : {}),
  });
  const client = options.throughWorker
    ? workerClient(daemon)
    : fakeClient(daemon, daemon.token, options.outbox);
  const storage = options.storage ?? memoryKeyValue();
  return {
    daemon,
    /** The other machines' daemons, by host id. */
    machines: new Map(others.map((other) => [other.hostId as string, other])),
    client,
    storage,
    play: (scenario: Scenario) => new ScenarioPlayer(daemon, scenario),
    async open(path: string) {
      // The browser warms these while idle after first paint; tests start with them warm.
      await Promise.all([client.start(), preloadDeferred()]);
      const machines = others.length
        ? await fakeMachinePool(others, (other) => fakeClient(other))
        : undefined;
      if (machines) running.push(machines);
      const connection = fakeConnection(daemon);
      return render(
        <AppFrame
          environment={{ storage, root: document.documentElement, matchMedia: options.matchMedia }}
        >
          <DaemonConnectionContext.Provider value={connection}>
            <App
              client={client}
              queryClient={createQueryClient()}
              storage={storage}
              history={createMemoryHistory({ initialEntries: [path] })}
              machines={machines}
            />
          </DaemonConnectionContext.Provider>
        </AppFrame>,
      );
    },
  };
}

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** The page's side of the client worker, with the worker's host on a MessageChannel. */
function workerClient(daemon: FakeDaemon): ClientApi {
  const host = new ClientHost({
    target: () => ({ key: "fake", create: () => fakeClient(daemon) }),
    scheduler: timers,
    now: () => Date.now(),
    frameMs: 4,
    lingerMs: 1,
  });
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  const remote = new RemoteClient(port2, {}, { scheduler: timers });
  running.push(remote);
  return remote;
}
