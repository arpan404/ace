import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RemoteAuth } from "../remote-auth.ts";
import { Store } from "../store.ts";

// Tickets an NK first message carries (ADR 0155): one use, bound to the device, its credential
// and the relay key that handed them, voided by revocation, and nothing recorded on use.

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ace-nk-tickets-")), "events.sqlite"));
  stores.push(store);
  let now = 1_000;
  const auth = new RemoteAuth(store.devices, "a".repeat(64), {
    now: () => now,
    secret: randomUUID,
  });
  const paired = auth.redeem(auth.pairing(["read"]).code, "Phone");
  const device = store.devices.authenticate(paired.token, now);
  if (!device) throw new Error("Not paired");
  const actor = { ...device, revocable: true };
  return { store, auth, paired, actor, advance: (ms: number) => (now += ms) };
}

it("a ticket opens one NK session, only under the relay key that handed it and for its own device", () => {
  const { auth, actor } = setup();
  const first = auth.handOver(actor, "relay-key-a")?.ticket ?? "";
  // Refused without being spent: under another key, or claimed by another device.
  expect(auth.consumeEarly(first, "relay-key-b", actor.id)).toBeUndefined();
  expect(auth.consumeEarly(first, "relay-key-a", "another-device")).toBeUndefined();
  expect(auth.consumeEarly(first, "relay-key-a", actor.id)?.id).toBe(actor.id);
  expect(auth.consumeEarly(first, "relay-key-a", actor.id)).toBeUndefined();
  // One handed on the direct path is bound to no relay key.
  const direct = auth.handOver(actor)?.ticket ?? "";
  expect(auth.consumeEarly(direct, "relay-key-a", actor.id)).toBeUndefined();
});

it("revoking the device voids its outstanding tickets, and a ticket lives 60 s", () => {
  const { auth, actor, advance } = setup();
  const kept = auth.handOver(actor, "key")?.ticket ?? "";
  const late = auth.handOver(actor, "key")?.ticket ?? "";
  advance(60_001);
  expect(auth.consumeEarly(late, "key", actor.id)).toBeUndefined();
  const fresh = auth.handOver(actor, "key")?.ticket ?? "";
  auth.revoke(actor.id);
  expect(auth.consumeEarly(fresh, "key", actor.id)).toBeUndefined();
  expect(auth.consumeEarly(kept, "key", actor.id)).toBeUndefined();
});

it("an early ticket records nothing about the device until it is touched on confirmation", () => {
  const { store, auth, actor, advance } = setup();
  const seen = () => store.devices.list().find((device) => device.id === actor.id)?.lastSeenAt;
  const before = seen();
  advance(5_000);
  const device = auth.consumeEarly(auth.handOver(actor, "key")?.ticket ?? "", "key", actor.id);
  expect(seen()).toBe(before);
  if (device) auth.touch(device);
  expect(seen()).not.toBe(before);
});
