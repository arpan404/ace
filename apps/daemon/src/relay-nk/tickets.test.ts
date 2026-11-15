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
  const auth = new RemoteAuth(store.devices, "a".repeat(64), { now: () => now, secret: randomUUID });
  const paired = auth.redeem(auth.pairing(["read"]).code, "Phone");
  const device = store.devices.authenticate(paired.token, now);
  if (!device) throw new Error("Not paired");
  const actor = { ...device, revocable: true };
  return { store, auth, paired, actor, advance: (ms: number) => (now += ms) };
}

it("a ticket opens one NK session, only under the relay key that handed it", () => {
  const { auth, actor } = setup();
  const first = auth.handOver(actor, "relay-key-a")?.ticket ?? "";
  expect(auth.consumeEarly(first, "relay-key-b")).toBeUndefined();
  // Consumed by that refusal too: a ticket offered under the wrong key is spent.
  expect(auth.consumeEarly(first, "relay-key-a")).toBeUndefined();
  const second = auth.handOver(actor, "relay-key-a")?.ticket ?? "";
  expect(auth.consumeEarly(second, "relay-key-a")?.id).toBe(actor.id);
  expect(auth.consumeEarly(second, "relay-key-a")).toBeUndefined();
  // One handed on the direct path is bound to no relay key.
  const direct = auth.handOver(actor)?.ticket ?? "";
  expect(auth.consumeEarly(direct, "relay-key-a")).toBeUndefined();
});

it("revoking the device voids its outstanding tickets, and a ticket lives 60 s", () => {
  const { auth, actor, advance } = setup();
  const kept = auth.handOver(actor, "key")?.ticket ?? "";
  const late = auth.handOver(actor, "key")?.ticket ?? "";
  advance(60_001);
  expect(auth.consumeEarly(late, "key")).toBeUndefined();
  const fresh = auth.handOver(actor, "key")?.ticket ?? "";
  auth.revoke(actor.id);
  expect(auth.consumeEarly(fresh, "key")).toBeUndefined();
  expect(auth.consumeEarly(kept, "key")).toBeUndefined();
});

it("an early ticket records nothing about the device until it is touched on confirmation", () => {
  const { store, auth, actor, advance } = setup();
  const seen = () => store.devices.list().find((device) => device.id === actor.id)?.lastSeenAt;
  const before = seen();
  advance(5_000);
  const device = auth.consumeEarly(auth.handOver(actor, "key")?.ticket ?? "", "key");
  expect(seen()).toBe(before);
  if (device) auth.touch(device);
  expect(seen()).not.toBe(before);
});
