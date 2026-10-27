import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { until } from "./test-host.ts";

/** A real SDK connected to an in-process fake daemon, for the Settings screens' tests. Test-only. */
export async function settingsFixture(): Promise<{ owner: ClientCore; daemon: FakeDaemon }> {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-settings-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return { owner, daemon };
}
