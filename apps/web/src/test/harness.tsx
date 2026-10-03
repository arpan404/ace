import { Client } from "@ace/client";
import { FakeDaemon, ScenarioPlayer, fakeTransport, type Scenario } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { afterEach } from "vitest";
import { App, createQueryClient } from "@/app.tsx";
import { memoryStorage } from "@/boot/client.ts";

const running: Client[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((client) => client.close()));
});

/** The real app, a real @ace/client and a FakeDaemon speaking the wire protocol in memory. */
export function harness(options: { snapshotItems?: number } = {}) {
  let now = 1_000;
  let ids = 0;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    ...(options.snapshotItems ? { snapshotItems: options.snapshotItems } : {}),
  });
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
  return {
    daemon,
    client,
    play: (scenario: Scenario) => new ScenarioPlayer(daemon, scenario),
    async open(path: string) {
      await client.start();
      return render(
        <App
          client={client}
          queryClient={createQueryClient()}
          environment={{}}
          history={createMemoryHistory({ initialEntries: [path] })}
        />,
      );
    },
  };
}
