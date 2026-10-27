import { latest, native, until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { MachineAppUpdate } from "./machine-app-update.ts";
import { PatchPump } from "./patches.ts";

/*
 * The desktop app's update on the machine page, read-only, over the real SDK and an in-process
 * fake daemon: Unknown until the app reports, then its version and one line, kept current.
 */

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const clients: ClientCore[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  native.frames.length = 0;
});

async function connect(fixture: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-app-update-test"),
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

const report = {
  version: "1.4.1",
  available: null,
  downloaded: false,
  restartRequired: false,
  releaseUrl: null,
};

test("the machine page reads Unknown until the desktop app reports, then follows each change", async () => {
  const fixture = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const follower = new MachineAppUpdate(await connect(fixture), pump);
  expect(await until(() => latest("machine.appUpdate"))).toMatchObject({
    known: true,
    version: "Unknown",
    line: null,
    needsYou: false,
  });
  fixture.seedServices({ appUpdate: report });
  await until(() => latest("machine.appUpdate")?.line === "Up to date");
  expect(latest("machine.appUpdate")?.version).toBe("1.4.1");
  fixture.seedServices({ appUpdate: { ...report, available: "1.4.2" } });
  await until(() => latest("machine.appUpdate")?.line === "Update 1.4.2 available");
  fixture.seedServices({
    appUpdate: { ...report, available: "1.4.2", downloaded: true, restartRequired: true },
  });
  const restart = await until(() =>
    latest("machine.appUpdate")?.needsYou === true ? latest("machine.appUpdate") : undefined,
  );
  expect(restart?.line).toBe("Restart to finish updating");
  follower.dispose();
});
