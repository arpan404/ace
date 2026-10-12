import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, fakeTransport, type Scenario } from "@ace/fake-daemon";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach } from "vitest";
import { browserClientOptions, memoryStorage } from "@/boot/client.ts";
import { ToastProvider } from "@/components/ui/toast.tsx";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** A component's real protocol boundary without loading unrelated routes and panels. */
export async function componentClient(scenario: Scenario) {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, scenario).runUntilBlocked();
  let sequence = 0;
  const client = new Client({
    ...browserClientOptions({
      deviceId: "component-test",
      transport: () => fakeTransport(daemon),
      credential: async () => daemon.token,
      storage: memoryStorage(),
    }),
    id: () => `command-${++sequence}`,
    random: () => 0.5,
  });
  clients.push(client);
  await client.start();
  return {
    daemon,
    client,
    render(children: ReactNode) {
      return render(
        <ClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </ClientProvider>,
      );
    },
  };
}
