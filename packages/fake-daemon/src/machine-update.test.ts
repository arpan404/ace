import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, type MachineUpdateRequest, type ServerMessage } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function connected(daemon: FakeDaemon, device = "window") {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse(device),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  await client.start();
  await ready.promise;
  stop();
  const heard: string[] = [];
  client.onMessage((message: ServerMessage) => {
    if (message.type === "machineUpdate.changed") heard.push(message.update.state);
  });
  return {
    client,
    heard,
    ask: (fields: Omit<MachineUpdateRequest, "type" | "requestId">) =>
      client.request({ type: "machineUpdate.request", ...fields }),
  };
}

test("an update asked for when idle waits for the agents, downloads, restarts and reports updated", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 2 });
  const { client, ask, heard } = await connected(daemon);
  try {
    expect((await ask({ operation: "status" })).update).toMatchObject({ available: "0.0.19" });
    const started = await ask({ operation: "start", mode: "idle", version: "0.0.19", agents: 2 });
    expect(started).toMatchObject({ ok: true, update: { state: "waiting", busy: 2 } });
    while (daemon.machineUpdate.step());
    expect(daemon.machineUpdate.get()).toMatchObject({
      version: "0.0.19",
      state: "updated",
      available: null,
      last: { from: "0.0.18", to: "0.0.19", ok: true },
    });
    await expect.poll(() => heard.at(-1)).toBe("updated");
    expect(heard).toEqual(
      expect.arrayContaining(["waiting", "downloading", "ready", "installing", "updated"]),
    );
  } finally {
    await client.close();
  }
});

test("starting refuses a stale version, unconfirmed agents and a blocked install, and fails when seeded to", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 3 });
  const { client, ask } = await connected(daemon);
  try {
    expect(await ask({ operation: "start", mode: "idle", version: "0.0.18" })).toMatchObject({
      ok: false,
      error: "stale",
    });
    expect(
      await ask({ operation: "start", mode: "now", version: "0.0.19", agents: 1 }),
    ).toMatchObject({ ok: false, error: "confirm", update: { busy: 3 } });
    daemon.machineUpdate.seed({ busy: 0 }, { fails: "The download was cut off." });
    await ask({ operation: "start", mode: "now", version: "0.0.19", agents: 0 });
    daemon.machineUpdate.step();
    expect(daemon.machineUpdate.get()).toMatchObject({
      state: "failed",
      error: "The download was cut off.",
      version: "0.0.18",
    });
    daemon.machineUpdate.seed({ blocked: "release-page" });
    expect(await ask({ operation: "start", mode: "idle", version: "0.0.19" })).toMatchObject({
      ok: false,
      error: "blocked",
    });
  } finally {
    await client.close();
  }
});

test("a read-only device reads the update but can't start it", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, deviceScopes: { phone: ["read"] } });
  daemon.machineUpdate.seed({ state: "available", available: "0.0.19" });
  const { client, ask } = await connected(daemon, "phone");
  try {
    expect(await ask({ operation: "status" })).toMatchObject({ ok: true });
    expect(await ask({ operation: "start", mode: "idle", version: "0.0.19" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(daemon.machineUpdate.get().ask).toBeNull();
  } finally {
    await client.close();
  }
});
