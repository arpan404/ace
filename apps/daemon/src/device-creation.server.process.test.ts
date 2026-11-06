import { once } from "node:events";
import { expect, it } from "vitest";
import { parsePairingLink } from "@ace/client/access";
import { Command, CommandId, DeviceCredential, DeviceId } from "@ace/protocol";
import { setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

it("rejected public device creation leaves persistent listings unchanged and usable", async () => {
  const f = await setup();
  const valid = f.store.devices.create("Existing", ["read"], 1000);
  for (const rejected of [
    () => f.store.devices.create("", ["read"], 1000),
    () => f.store.devices.create("Bad scopes", [], 1000),
    () => f.store.devices.create("Bad timestamp", ["read"], -1),
  ]) {
    expect(rejected).toThrow();
    await expect(f.request("/v1/devices", { token })).resolves.toEqual([valid.device]);
    expect(f.store.devices.list()).toEqual([valid.device]);
  }
});

it("uses all 32 bytes of supplied entropy and the supplied id for a usable device credential", async () => {
  const f = await setup();
  const { Store } = await import("./store.ts");
  const { join } = await import("node:path");
  const { cleanups } = await import("./remote-test-support.ts");
  const bytes = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex",
  );
  const store = new Store(join(f.home, "entropy.sqlite"), undefined, {
    id: () => "supplied-device",
    randomBytes: (size) => bytes.subarray(0, size),
  });
  cleanups.push(() => store.close());
  const created = store.devices.create("Phone", ["read"], 1000);
  expect(created.token).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  expect(created.device.id).toBe("supplied-device");
  expect(store.devices.authenticate(created.token, 2000)).toMatchObject({
    id: "supplied-device",
    lastSeenAt: 2000,
  });
});

it("rejects invalid lifecycle timestamps without damaging a stored credential", async () => {
  const f = await setup();
  const created = f.store.devices.create("Phone", ["read"], 1000);
  for (const rejected of [
    () => f.store.devices.touch(created.device.id, -1),
    () => f.store.devices.authenticate(created.token, Number.NaN),
    () => f.store.devices.revoke(created.device.id, -1),
  ]) {
    expect(rejected).toThrow();
    expect(f.store.devices.list()).toEqual([created.device]);
  }
});

it("undersized entropy never persists a device credential", async () => {
  const f = await setup();
  const { Store } = await import("./index.ts");
  const { join } = await import("node:path");
  const path = join(f.home, "short-entropy.sqlite");
  const store = new Store(path, undefined, {
    id: () => "short-entropy-device",
    randomBytes: () => new Uint8Array([42]),
  });
  try {
    expect(() => store.devices.create("Phone", ["read"], 1000)).toThrow(
      "Credential entropy source must return 32 bytes",
    );
    expect(store.devices.list()).toEqual([]);
  } finally {
    store.close();
  }
  const reopened = new Store(path);
  try {
    expect(reopened.devices.list()).toEqual([]);
    const valid = reopened.devices.create("Valid phone", ["read"], 1000);
    expect(reopened.devices.authenticate(valid.token, 2000)).toMatchObject({
      id: valid.device.id,
      name: "Valid phone",
    });
  } finally {
    reopened.close();
  }
});

const installId = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e";
/** A pinned socket opened with a fresh ticket, its hello naming the app install. */
async function helloFrom(
  f: Awaited<ReturnType<typeof setup>>,
  deviceId: string,
  credential: string,
) {
  const { ticket } = await f.ticket(credential);
  const client = await f.open();
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(deviceId),
    ticket,
    installId,
  });
  return client;
}

it("a phone connected over LAN and Tailscale at once is one device on the daemon", async () => {
  const f = await setup();
  // Paired once from the LAN link and once from the Tailscale link: one install.
  const redeem = async () =>
    DeviceCredential.parse(
      await f.remoteRequest("/v1/pair", {
        method: "POST",
        body: { code: parsePairingLink((await f.pairing()).url).code, name: "Phone", installId },
      }),
    );
  const lan = await redeem();
  const tailscale = await redeem();
  expect(tailscale.device.id).toBe(lan.device.id);
  const overLan = await helloFrom(f, tailscale.device.id, tailscale.token);
  const overTailscale = await helloFrom(f, tailscale.device.id, tailscale.token);
  expect(await overLan.next()).toMatchObject({ type: "welcome" });
  expect(await overTailscale.next()).toMatchObject({ type: "welcome" });
  expect(await f.request("/v1/devices", { token })).toEqual([
    expect.objectContaining({ id: lan.device.id, name: "Phone", revokedAt: null }),
  ]);
});

it("signing out and in again keeps one device: records an install left behind fold into the one it uses", async () => {
  const f = await setup();
  // Before installs had ids, pairing again after signing back in left the first record behind.
  f.store.devices.create("Phone", ["read", "operate"], 1000);
  f.advance(1000);
  const used = f.store.devices.create("Phone", ["read", "operate"], 2000);
  const other = f.store.devices.create("Tablet", ["read"], 2000);
  expect(await f.request("/v1/devices", { token })).toHaveLength(3);

  const client = await helloFrom(f, used.device.id, used.token);
  expect(await client.next()).toMatchObject({ type: "welcome" });
  expect(await f.request("/v1/devices", { token })).toEqual([
    expect.objectContaining({ id: used.device.id }),
    expect.objectContaining({ id: other.device.id }),
  ]);
  // Paired again from the same install: the same record, never a new one.
  const again = DeviceCredential.parse(
    await f.remoteRequest("/v1/pair", {
      method: "POST",
      body: { code: parsePairingLink((await f.pairing()).url).code, name: "Phone", installId },
    }),
  );
  expect(again.device.id).toBe(used.device.id);
  expect(await f.request("/v1/devices", { token })).toHaveLength(2);
});

it("a folded record that is used again is listed again, and removing an install removes its folded records", async () => {
  const f = await setup();
  const left = f.store.devices.create("Phone", ["read"], 1000);
  f.advance(1000);
  const used = f.store.devices.create("Phone", ["read"], 2000);
  expect(await (await helloFrom(f, used.device.id, used.token)).next()).toMatchObject({
    type: "welcome",
  });
  expect(await f.request("/v1/devices", { token })).toHaveLength(1);
  // It was another phone with the same name after all: it keeps its access and shows again.
  expect(await f.ticket(left.token)).toMatchObject({ ticket: expect.any(String) });
  expect(await f.request("/v1/devices", { token })).toHaveLength(2);

  const third = f.store.devices.create("Phone", ["read"], 500);
  expect(await (await helloFrom(f, used.device.id, used.token)).next()).toMatchObject({
    type: "welcome",
  });
  await f.request(`/v1/devices/${used.device.id}`, { method: "DELETE", token });
  await expect(f.ticket(third.token)).rejects.toThrow("HTTP 401");
  await expect(f.ticket(left.token)).resolves.toMatchObject({ ticket: expect.any(String) });
});

/** Redeems a fresh pairing link with `scopes` from this test's app install. */
async function pairInstall(f: Awaited<ReturnType<typeof setup>>, scopes: string[]) {
  return DeviceCredential.parse(
    await f.remoteRequest("/v1/pair", {
      method: "POST",
      body: {
        code: parsePairingLink((await f.pairing(scopes)).url).code,
        name: "Phone",
        installId,
      },
    }),
  );
}

it("pairing an install again as admin gives nothing its old read-only credential opened the new authority", async () => {
  const f = await setup();
  const viewer = await pairInstall(f, ["read"]);
  const socket = await helloFrom(f, viewer.device.id, viewer.token);
  expect(await socket.next()).toMatchObject({ type: "welcome" });
  const closed = once(socket.socket, "close");
  // Asked for before the owner paired the install again with admin.
  const early = await f.ticket(viewer.token);

  const admin = await pairInstall(f, ["admin"]);
  expect(admin.device.id).toBe(viewer.device.id);
  // The socket the read-only credential opened ends, without the revocation wipe.
  expect((await closed)[0]).toBe(4001);
  // Its ticket opens nothing now: it would otherwise come back with admin.
  const stale = await f.connectTicket(viewer.device.id, early.ticket);
  expect(await stale.next()).toMatchObject({ type: "error", code: "unauthorized" });
  await expect(f.ticket(viewer.token)).rejects.toThrow("HTTP 401");
  const fresh = await helloFrom(f, admin.device.id, admin.token);
  expect(await fresh.next()).toMatchObject({ type: "welcome" });
});

it("removing an install closes the subscribed socket of a record folded into it", async () => {
  const f = await setup();
  // Left behind by an older app, still connected and watching the thread list.
  const left = f.store.devices.create("Phone", ["read"], 1000);
  const watching = await f.connectTicket(left.device.id, (await f.ticket(left.token)).ticket);
  expect(await watching.next()).toMatchObject({ type: "welcome" });
  watching.send({ type: "subscribe", subscriptionId: "threads", scope: { kind: "threads" } });
  expect(await watching.next()).toMatchObject({ type: "snapshot" });
  const closed = once(watching.socket, "close");

  f.advance(1000);
  const used = f.store.devices.create("Phone", ["read"], 2000);
  expect(await (await helloFrom(f, used.device.id, used.token)).next()).toMatchObject({
    type: "welcome",
  });
  expect(await f.request("/v1/devices", { token })).toHaveLength(1);

  await f.request(`/v1/devices/${used.device.id}`, { method: "DELETE", token });
  expect((await closed)[0]).toBe(4003);
  await expect(f.ticket(left.token)).rejects.toThrow("HTTP 401");
});

it("a hello naming another device's install id folds nothing and takes nothing over", async () => {
  const f = await setup();
  const admin = await pairInstall(f, ["admin"]);
  expect(await (await helloFrom(f, admin.device.id, admin.token)).next()).toMatchObject({
    type: "welcome",
  });
  // An older app's read-only credential claims the admin install's id, which is no secret.
  const viewer = f.store.devices.create("Tablet", ["read"], 1000);
  expect(await (await helloFrom(f, viewer.device.id, viewer.token)).next()).toMatchObject({
    type: "welcome",
  });
  expect((await f.request("/v1/devices", { token })) as unknown[]).toHaveLength(2);

  await f.request(`/v1/devices/${viewer.device.id}`, { method: "DELETE", token });
  await expect(f.ticket(admin.token)).resolves.toMatchObject({ ticket: expect.any(String) });
});

it("a record left behind with more access than the one in use is never folded under it", async () => {
  const f = await setup();
  const left = f.store.devices.create("Phone", ["admin"], 1000);
  f.advance(1000);
  const used = f.store.devices.create("Phone", ["read"], 2000);
  expect(await (await helloFrom(f, used.device.id, used.token)).next()).toMatchObject({
    type: "welcome",
  });
  expect(await f.request("/v1/devices", { token })).toEqual([
    expect.objectContaining({ id: left.device.id }),
    expect.objectContaining({ id: used.device.id }),
  ]);
  await f.request(`/v1/devices/${used.device.id}`, { method: "DELETE", token });
  await expect(f.ticket(left.token)).resolves.toMatchObject({ ticket: expect.any(String) });
});

/** Asks `client` for `commandId`'s state; its reply and any result frame sent before it. */
async function statusOf(client: Awaited<ReturnType<typeof helloFrom>>, commandId: string) {
  client.send({
    type: "command.status",
    requestId: "status",
    commandIds: [CommandId.parse(commandId)],
  });
  const seen: unknown[] = [];
  for (;;) {
    const message = await client.next();
    seen.push(message);
    if (message.type === "command.status") return seen;
  }
}

it("an older credential naming an account-only phone's install sees none of that phone's command results", async () => {
  const f = await setup();
  // The phone reaches this machine only through the ace account: its device id is its install id.
  f.store.recordCommand(CommandId.parse("phone-secret"), DeviceId.parse(installId), () => ({
    commandId: CommandId.parse("phone-secret"),
    ok: true,
  }));
  const legacy = f.store.devices.create("Old tablet", ["read", "operate"], 1000);
  const claimer = await helloFrom(f, legacy.device.id, legacy.token);
  expect(await claimer.next()).toMatchObject({ type: "welcome" });

  expect(await statusOf(claimer, "phone-secret")).toEqual([
    expect.objectContaining({
      type: "command.status",
      commands: [{ commandId: "phone-secret", state: "unknown" }],
    }),
  ]);
});

it("a pairing code naming an account-only phone's install gets a device id of its own and none of its results", async () => {
  const f = await setup();
  f.store.recordCommand(CommandId.parse("phone-secret"), DeviceId.parse(installId), () => ({
    commandId: CommandId.parse("phone-secret"),
    ok: true,
  }));
  const claimed = await pairInstall(f, ["read", "operate"]);
  expect(claimed.device.id).not.toBe(installId);
  const claimer = await helloFrom(f, claimed.device.id, claimed.token);
  expect(await claimer.next()).toMatchObject({ type: "welcome" });
  expect(await statusOf(claimer, "phone-secret")).toEqual([
    expect.objectContaining({ commands: [{ commandId: "phone-secret", state: "unknown" }] }),
  ]);
});

it("work a replaced credential started finds no authority when it checks again, not even the new pairing's", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const checked: boolean[] = [];
  const f = await setup({
    projects: {
      subscribe: () => () => {},
      onProgress: () => () => {},
      useThreadDeletion: () => () => {},
      async execute(command: { id: CommandId }, allowed: () => boolean) {
        checked.push(allowed());
        await held;
        checked.push(allowed());
        return { commandId: command.id, ok: true };
      },
    } as unknown as import("./projects.ts").Projects,
  });
  const first = await pairInstall(f, ["read", "projects"]);
  const socket = await helloFrom(f, first.device.id, first.token);
  expect(await socket.next()).toMatchObject({ type: "welcome" });
  socket.send({
    type: "command",
    command: Command.parse({
      id: "long-add",
      deviceId: first.device.id,
      payload: { type: "workspace.add", path: f.home },
    }),
  });
  await expect.poll(() => checked).toEqual([true]);
  // Paired again from the same install with more access while the work waits.
  const again = await pairInstall(f, ["admin", "projects"]);
  expect(again.device.id).toBe(first.device.id);
  release();
  await expect.poll(() => checked).toEqual([true, false]);
});

it("removing an install withdraws notifications from the records folded into it", async () => {
  const revoked: string[] = [];
  const f = await setup({
    notifications: {
      async connectDevice() {},
      async disconnect() {},
      async updatePresence() {},
      async register() {},
      async preferences() {},
      async snooze() {},
      async revoke(id: string) {
        revoked.push(id);
      },
    },
  });
  const left = f.store.devices.create("Phone", ["read"], 1000);
  f.advance(1000);
  const used = f.store.devices.create("Phone", ["read"], 2000);
  expect(await (await helloFrom(f, used.device.id, used.token)).next()).toMatchObject({
    type: "welcome",
  });
  await f.request(`/v1/devices/${used.device.id}`, { method: "DELETE", token });
  await expect.poll(() => revoked.toSorted()).toEqual([left.device.id, used.device.id].toSorted());
});
