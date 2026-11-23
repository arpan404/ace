import { latest, native, until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { MachineUpdateFollower } from "./machine-update.ts";
import { PatchPump } from "./patches.ts";

/* The machine's own update over the real SDK and the in-process fake daemon. */

const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
const clients: ClientCore[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  native.frames.length = 0;
});

async function connect(fixture: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-machine-update-test"),
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

const fresh = () =>
  new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "ios-test-token" });
const signal = new AbortController().signal;

test("status shows the running version; a check that finds a release offers it", async () => {
  const fixture = fresh();
  fixture.machineUpdate.seed({ version: "0.0.24" });
  const follower = new MachineUpdateFollower(await connect(fixture), pump);
  expect(await until(() => latest("machine.update"))).toMatchObject({
    known: true,
    version: "0.0.24",
    phase: "current",
    available: null,
  });
  fixture.machineUpdate.seed({ available: "0.0.25", state: "available" });
  await until(() => latest("machine.update")?.available === "0.0.25");
  expect(latest("machine.update")?.phase).toBe("available");
  const checked = await follower.answer({ type: "machine.update.check" }, signal);
  expect(checked).toMatchObject({ available: "0.0.25", phase: "available" });
  follower.dispose();
});

test("start reports progress, then the restart, then the new version", async () => {
  const fixture = fresh();
  fixture.machineUpdate.seed({ version: "0.0.24", available: "0.0.25", state: "available" });
  const follower = new MachineUpdateFollower(await connect(fixture), pump);
  await until(() => latest("machine.update")?.phase === "available");
  await follower.answer({ type: "machine.update.start", version: "0.0.25", mode: "idle" }, signal);
  await until(() => latest("machine.update")?.phase === "downloading");
  fixture.machineUpdate.step();
  await until(() => latest("machine.update")?.percent === 50);
  fixture.machineUpdate.step();
  await until(() => latest("machine.update")?.phase === "restarting");
  fixture.machineUpdate.step();
  fixture.machineUpdate.step();
  const done = await until(() =>
    latest("machine.update")?.version === "0.0.25" ? latest("machine.update") : undefined,
  );
  expect(done).toMatchObject({ phase: "current", available: null });
  follower.dispose();
});

test("refusals are the person's words: agents not confirmed, a closed app", async () => {
  const fixture = fresh();
  fixture.machineUpdate.seed({ available: "0.0.25", state: "available", busy: 2 });
  const follower = new MachineUpdateFollower(await connect(fixture), pump);
  await until(() => latest("machine.update")?.busy === 2);
  await expect(
    follower.answer(
      { type: "machine.update.start", version: "0.0.25", mode: "now", agents: 1 },
      signal,
    ),
  ).rejects.toThrow(/agents are working/);
  fixture.machineUpdate.seed({ blocked: "app-closed" });
  await until(() => latest("machine.update")?.blocked === "app-closed");
  await expect(
    follower.answer({ type: "machine.update.start", version: "0.0.25", mode: "idle" }, signal),
  ).rejects.toThrow(/can't update itself/);
  follower.dispose();
});
