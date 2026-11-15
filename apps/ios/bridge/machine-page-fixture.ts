import { until } from "./test-host.ts";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId, type DeviceScope } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/** A phone's runtime on a fake machine, asking native services as Swift does. */
export async function machinePhone(scopes?: readonly DeviceScope[]) {
  const device = "ios-machine-page-test";
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    displayName: "studio",
    ...(scopes ? { deviceScopes: { [device]: scopes } } : {}),
  });
  const owner = new ClientCore({
    deviceId: DeviceId.parse(device),
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
  const sink = new RecordingSink();
  const services = new NativeServices(owner, sink);
  let next = 0;
  const ask = async <T>(request: Record<string, unknown>): Promise<T> => {
    const id = `call-${next++}`;
    services.handle({ type: "service", id, request });
    await until(() => sink.read(`service:${id}`));
    const reply = sink.read(`service:${id}`) as { ok: boolean; value: T; message: string };
    if (!reply.ok) throw new Error(reply.message);
    return reply.value;
  };
  return { daemon, owner, ask, close: () => owner.close() };
}
