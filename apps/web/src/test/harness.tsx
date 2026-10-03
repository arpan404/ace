import { Client } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, fakeTransport, type Scenario } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { afterEach } from "vitest";
import { App, AppFrame, createQueryClient } from "@/app.tsx";
import { memoryStorage } from "@/boot/client.ts";
import type { KeyValueStorage } from "@/lib/storage.ts";

const running: Client[] = [];
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
export function fakeClient(daemon: FakeDaemon): Client {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
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
export function harness(options: { snapshotItems?: number; storage?: KeyValueStorage } = {}) {
  let now = 1_000;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    ...(options.snapshotItems ? { snapshotItems: options.snapshotItems } : {}),
  });
  const client = fakeClient(daemon);
  const storage = options.storage ?? memoryKeyValue();
  return {
    daemon,
    client,
    storage,
    play: (scenario: Scenario) => new ScenarioPlayer(daemon, scenario),
    async open(path: string) {
      await client.start();
      return render(
        <AppFrame environment={{ storage, root: document.documentElement }}>
          <App
            client={client}
            queryClient={createQueryClient()}
            storage={storage}
            history={createMemoryHistory({ initialEntries: [path] })}
          />
        </AppFrame>,
      );
    },
  };
}
