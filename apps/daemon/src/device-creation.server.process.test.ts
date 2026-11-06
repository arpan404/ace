import { expect, it } from "vitest";
import { parsePairingLink } from "@ace/client/access";
import { DeviceCredential, DeviceId } from "@ace/protocol";
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
  const left = f.store.devices.create("Phone", ["read", "operate"], 1000);
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
