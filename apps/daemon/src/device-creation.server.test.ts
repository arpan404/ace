import { expect, it } from "vitest";
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
