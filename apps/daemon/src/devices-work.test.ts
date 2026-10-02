import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Store } from "./index.ts";

it("authenticates and lists devices without preparing SQL per request", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const phone = store.devices.create("Phone", ["read"], 1);
    const desktop = store.devices.create("Desktop", ["admin"], 2);
    const prepare = vi.spyOn(db, "prepare");
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
    // Count work at the real SQLite boundary; returned auth data is asserted above.
    expect(prepare.mock.calls.length).toBe(0);
    prepare.mockRestore();
  } finally {
    store.close();
  }
});
