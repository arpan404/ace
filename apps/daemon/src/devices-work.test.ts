import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Store } from "./index.ts";

it("authenticates and lists devices within the SQLite compilation budget", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const phone = store.devices.create("Phone", ["read"], 1);
    const desktop = store.devices.create("Desktop", ["admin"], 2);
    const prepare = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("Device request exhausted its SQL compilation budget");
    });
    for (let i = 0; i < 100; i++) {
      expect(store.devices.authenticate(phone.token, i + 3)).toMatchObject({
        id: phone.device.id,
        scopes: ["read"],
        lastSeenAt: i + 3,
      });
      expect(store.devices.authenticate("invalid", i + 3)).toBeUndefined();
    }
    expect(store.devices.list()).toMatchObject([
      { id: phone.device.id, lastSeenAt: 102 },
      { id: desktop.device.id, lastSeenAt: 2 },
    ]);
    expect(store.devices.revoke(phone.device.id, 103)).toBe(true);
    expect(store.devices.authenticate(phone.token, 104)).toBeUndefined();
    expect(store.devices.list()[0]?.revokedAt).toBe(103);
    prepare.mockRestore();
  } finally {
    store.close();
  }
});

it("lists devices within a linear SQLite row-read budget", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const devices = Array.from(
      { length: 16 },
      (_, i) => store.devices.create(`Device ${i}`, ["read"], i + 1).device,
    );
    let reads = 0;
    db.function("read_device_id", (id) => {
      if (++reads > devices.length * 4)
        throw new Error("Device listing exceeded its row-read budget");
      if (typeof id !== "string") throw new Error("Invalid device id");
      return id;
    });
    // Meter the real SQLite edge. Repeated point lookups through this view
    // must revisit rows, even if every lookup statement was prepared earlier.
    db.exec(
      "ALTER TABLE devices RENAME TO metered_devices; CREATE VIEW devices AS SELECT read_device_id(id) AS id, name, token_hash, scopes, created_at, last_seen_at, revoked_at FROM metered_devices",
    );
    expect(store.devices.list()).toEqual(devices);
  } finally {
    store.close();
  }
});
