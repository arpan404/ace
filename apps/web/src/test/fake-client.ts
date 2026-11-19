import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { memoryStorage } from "@/boot/client.ts";

type ClientStorage = ReturnType<typeof memoryStorage>;
const running: Client[] = [];
// Unmount first: a client closed under a mounted app has its views subscribe to a closed client.
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((client) => client.close()));
});

/** A @ace/client wired to a FakeDaemon speaking the wire protocol in memory. */
export function fakeClient(
  daemon: FakeDaemon,
  token = daemon.token,
  outbox: ClientStorage = memoryStorage(),
  expectedHostId?: string,
): Client {
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    ...(expectedHostId ? { expectedHostId: HostId.parse(expectedHostId) } : {}),
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
