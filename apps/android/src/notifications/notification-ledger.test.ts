import { expect, test } from "vitest";
import {
  createHostLedgers,
  createNotificationLedger,
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

test("the cursor only moves to the daemon's head, including a rebuild", () => {
  const ledger = createNotificationLedger({ cursor: 7, shown: [] });
  expect(ledger.cursor).toBe(7);
  ledger.advance(4);
  expect(ledger.cursor).toBe(4);
  ledger.advance(9);
  expect(ledger.cursor).toBe(9);
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

test("ledger snapshots persist per host and restore on next launch", () => {
  const saved = new Map<string, { cursor: number; shown: readonly string[] }>();
  const first = createHostLedgers({
    load: (hostId) => saved.get(hostId) ?? null,
    save: (hostId, snapshot) => {
      saved.set(hostId, snapshot);
    },
  });
  first.admit("host-a", "n-1");
  first.advance("host-a", 5);
  const second = createHostLedgers({
    load: (hostId) => saved.get(hostId) ?? null,
    save: (hostId, snapshot) => {
      saved.set(hostId, snapshot);
    },
  });
  expect(second.snapshot("host-a")).toEqual({ cursor: 5, shown: ["n-1"] });
  expect(second.admit("host-a", "n-1")).toBe(false);
});
