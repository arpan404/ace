import { expect, test } from "vitest";
import {
  createHostLedgers,
  createNotificationLedger,
  ledgerScope,
  NOTIFICATION_LEDGER_CAPACITY,
} from "./notification-ledger.ts";

test("the first sighting of an id is admitted once", () => {
  const ledger = createNotificationLedger();
  expect(ledger.admit("n-1")).toBe(true);
  expect(ledger.admit("n-1")).toBe(false);
  expect(ledger.admit("n-2")).toBe(true);
});

test("only the newest 512 ids are remembered", () => {
  const ledger = createNotificationLedger();
  for (let index = 0; index < NOTIFICATION_LEDGER_CAPACITY + 10; index += 1)
    ledger.admit(`n-${index}`);
  expect(ledger.shown).toHaveLength(NOTIFICATION_LEDGER_CAPACITY);
  // The oldest aged out, so seeing it again reads as new.
  expect(ledger.admit("n-0")).toBe(true);
  expect(ledger.admit(`n-${NOTIFICATION_LEDGER_CAPACITY + 9}`)).toBe(false);
});

test("the cursor follows the daemon head, including a rebuilt database", () => {
  const ledger = createNotificationLedger({ cursor: 7, shown: [] });
  expect(ledger.cursor).toBe(7);
  ledger.advance(4);
  expect(ledger.cursor).toBe(4);
  ledger.advance(9);
  expect(ledger.cursor).toBe(9);
});

test("a rebuilt database rewinds the cursor but keeps shown-id dedup", () => {
  const ledger = createNotificationLedger({ cursor: 7, shown: ["n-1"] });
  ledger.advance(2);
  expect(ledger.cursor).toBe(2);
  // An id shown before the rebuild is still deduped; a new id admits.
  expect(ledger.admit("n-1")).toBe(false);
  expect(ledger.admit("n-2")).toBe(true);
});

test("each machine keeps its own cursor and shown ids", () => {
  const hosts = createHostLedgers();
  expect(hosts.admit("host-a", "n-1")).toBe(true);
  // The same daemon id from another machine is another notification.
  expect(hosts.admit("host-b", "n-1")).toBe(true);
  expect(hosts.admit("host-a", "n-1")).toBe(false);
  hosts.advance("host-a", 3);
  expect(hosts.cursor("host-a")).toBe(3);
  expect(hosts.cursor("host-b")).toBe(0);
});

test("the device is part of the scope, so a rotated device re-admits", () => {
  const before = createHostLedgers({ deviceId: "phone-1" });
  const after = createHostLedgers({ deviceId: "phone-2" });
  expect(before.admit("host-a", "n-1")).toBe(true);
  // Same host and daemon id on another device is another notification.
  expect(after.admit("host-a", "n-1")).toBe(true);
  expect(before.admit("host-a", "n-1")).toBe(false);
  expect(after.admit("host-a", "n-1")).toBe(false);
});

test("scope keys are injective and NUL-free", () => {
  expect(ledgerScope("host-a", "phone-1")).not.toBe(ledgerScope("host-a", "phone-2"));
  expect(ledgerScope("host-a", "phone-1")).not.toBe(ledgerScope("host-b", "phone-1"));
  expect(ledgerScope("ab", "c")).not.toBe(ledgerScope("a", "bc"));
  expect(ledgerScope("a\0b", "c")).not.toBe(ledgerScope("a", "b\0c"));
  expect(ledgerScope("a\0b", "c")).not.toContain("\0");
});

test("colliding alert ids on two machines stay independent", () => {
  const hosts = createHostLedgers({ deviceId: "phone-1" });
  expect(hosts.admit("host-a", "n-same")).toBe(true);
  expect(hosts.admit("host-b", "n-same")).toBe(true);
  hosts.advance("host-a", 5);
  expect(hosts.cursor("host-a")).toBe(5);
  expect(hosts.cursor("host-b")).toBe(0);
  expect(hosts.admit("host-a", "n-same")).toBe(false);
  expect(hosts.admit("host-b", "n-same")).toBe(false);
});

test("ledger snapshots persist per device and host and restore on next launch", () => {
  const saved = new Map<string, { cursor: number; shown: readonly string[] }>();
  const persistence = {
    load: (scope: string) => saved.get(scope) ?? null,
    save: (scope: string, snapshot: { cursor: number; shown: readonly string[] }) => {
      saved.set(scope, snapshot);
    },
  };
  const first = createHostLedgers({ deviceId: "phone-1", persistence });
  first.admit("host-a", "n-1");
  first.advance("host-a", 5);
  const second = createHostLedgers({ deviceId: "phone-1", persistence });
  expect(second.snapshot("host-a")).toEqual({ cursor: 5, shown: ["n-1"] });
  expect(second.admit("host-a", "n-1")).toBe(false);
});

test("a restart keeps dedup: persisted ids are not reposted from catch-up", () => {
  const saved = new Map<string, { cursor: number; shown: readonly string[] }>();
  const persistence = {
    load: (scope: string) => saved.get(scope) ?? null,
    save: (scope: string, snapshot: { cursor: number; shown: readonly string[] }) => {
      saved.set(scope, snapshot);
    },
  };
  const beforeRestart = createHostLedgers({ deviceId: "phone-1", persistence });
  expect(beforeRestart.admit("host-a", "n-1")).toBe(true);
  beforeRestart.advance("host-a", 1);
  // Simulate a process restart: a fresh instance over the same storage.
  const afterRestart = createHostLedgers({ deviceId: "phone-1", persistence });
  expect(afterRestart.cursor("host-a")).toBe(1);
  expect(afterRestart.admit("host-a", "n-1")).toBe(false);
  expect(afterRestart.admit("host-a", "n-2")).toBe(true);
});
