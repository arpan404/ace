import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Devices } from "./devices.ts";
import { migrate } from "./migrations.ts";

function daemon() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const devices = new Devices(db, { id: randomUUID, randomBytes });
  return { keys: devices.appKeys, devices };
}

describe("the desktop app's keys for a daemon it didn't start", () => {
  it("one sign-in registers one key, and a later sign-in registers the next", () => {
    const { keys } = daemon();
    expect(keys.register("a".repeat(43), 1_000, 5_000)).toBe(true);
    expect(keys.register("b".repeat(43), 1_000, 5_001)).toBe(false);
    expect(keys.register("b".repeat(43), 999, 5_002)).toBe(false);
    expect(keys.register("b".repeat(43), 2_000, 6_000)).toBe(true);
  });

  it("holds one key at a time: registering one ends the last", () => {
    const { keys } = daemon();
    keys.register("a".repeat(43), 1_000, 5_000);
    keys.register("b".repeat(43), 2_000, 6_000);
    expect(keys.keys()).toEqual(["b".repeat(43)]);
  });

  it("is listed among the devices, and revoking that device ends the key", () => {
    const { keys, devices } = daemon();
    keys.register("a".repeat(43), 1_000, 5_000);
    const listed = devices.list().find((device) => device.name === "ace desktop app");
    expect(listed?.scopes).toEqual(["desktop"]);
    devices.revoke(listed?.id ?? "", 6_000);
    expect(keys.registered("a".repeat(43))).toBe(false);
  });
});
