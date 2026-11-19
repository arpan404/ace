import { latest, native, until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { MachineFollowers } from "./machine-followers.ts";
import { PatchPump } from "./patches.ts";

/*
 * A bridge that starts again follows only its new connection: the previous client's pause and
 * update changes no longer reach the phone.
 */

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const clients: ClientCore[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  native.frames.length = 0;
});

async function connect(fixture: FakeDaemon, device: string): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse(device),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(fixture),
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
  clients.push(owner);
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

const report = (version: string) => ({
  version,
  available: null,
  downloaded: false,
  restartRequired: false,
  releaseUrl: null,
});

test("after a restart the old connection's pause and update changes stop reaching the phone", async () => {
  const old = new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "ios-test-token" });
  const fresh = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const followers = new MachineFollowers();
  followers.replace(await connect(old, "ios-followers-old"), pump);
  await until(() => latest("machine.admission")?.known === true);
  followers.replace(await connect(fresh, "ios-followers-new"), pump);
  await until(() => latest("machine.appUpdate")?.known === true);
  native.frames.length = 0;

  // Someone pauses the old machine and its app reports; the phone must not hear either.
  const other = await connect(old, "ios-followers-other");
  await other.request({ type: "admission.request", operation: "pause", requestId: "pause" });
  old.seedServices({ appUpdate: report("9.9.9") });
  fresh.seedServices({ appUpdate: report("1.4.1") });
  await until(() => latest("machine.appUpdate")?.version === "1.4.1");
  expect(native.frames.some((frame) => frame.type === "machine.admission" && frame.paused)).toBe(
    false,
  );
  expect(native.frames.some((frame) => frame.version === "9.9.9")).toBe(false);
  followers.dispose();
});
