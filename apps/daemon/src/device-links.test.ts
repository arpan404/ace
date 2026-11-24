import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingLinkProof } from "@ace/client/link-proof";
import { DeviceId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { linkedLimit } from "@ace/notify";
import { capLinked } from "./notification-feed-view.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function store() {
  const home = mkdtempSync(join(tmpdir(), "ace-device-links-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const opened = new Store(join(home, "events.sqlite"), console.error);
  cleanup.push(() => opened.close());
  return opened;
}
const account = DeviceId.parse("account-phone");

it("a pairing and the account device that proved it list each other as the same device", async () => {
  const s = store();
  const paired = s.devices.create("Phone", ["read", "operate"], 1000);
  const other = s.devices.create("Laptop", ["read"], 1000);
  const proof = await pairingLinkProof(paired.token, paired.device.id, account, crypto.subtle);
  expect(s.devices.linked(account, 1000)).toEqual([]);
  expect(s.devices.link(account, proof, 1000)).toBe(true);

  expect(s.devices.linked(account, 1000)).toEqual([paired.device.id]);
  expect(s.devices.linked(paired.device.id, 1000)).toEqual([account]);
  expect(s.devices.linked(other.device.id, 1000)).toEqual([]);
});

it("a revoked pairing is nobody's other id", async () => {
  const s = store();
  const paired = s.devices.create("Phone", ["read", "operate"], 1000);
  const proof = await pairingLinkProof(paired.token, paired.device.id, account, crypto.subtle);
  s.devices.link(account, proof, 1000);
  s.devices.revoke(paired.device.id, 2000);

  expect(s.devices.linked(account, 3000)).toEqual([]);
  expect(s.devices.linked(paired.device.id, 3000)).toEqual([]);
});

it("the pairing a phone used most recently survives the cap on linked ids", async () => {
  const s = store();
  const pairings = [];
  for (let n = 0; n < linkedLimit + 4; n++) {
    const paired = s.devices.create(`Phone ${n}`, ["read"], 1000 + n);
    const proof = await pairingLinkProof(paired.token, paired.device.id, account, crypto.subtle);
    s.devices.link(account, proof, 1000 + n);
    pairings.push(paired.device.id);
  }
  // Sorted by id this one would be cut; it was seen last, so it stays.
  const lastUsed = pairings.toSorted().at(-1)!;
  s.devices.touch(lastUsed, 5000);

  const linked = s.devices.linked(pairings[0]!, 6000);
  expect(linked[0]).toBe(account);
  const forWorker = capLinked(s.devices.linked(account, 6000), linkedLimit);
  expect(forWorker.ids).toHaveLength(linkedLimit);
  expect(forWorker.ids[0]).toBe(lastUsed);
  expect(forWorker.cut).toBe(4);
});

it("an account hello that proves a pairing counts as that pairing's use", async () => {
  const s = store();
  const registering = s.devices.create("Phone", ["read"], 1000);
  const proof = await pairingLinkProof(
    registering.token,
    registering.device.id,
    account,
    crypto.subtle,
  );
  s.devices.link(account, proof, 1000);
  for (let n = 0; n < linkedLimit + 2; n++) {
    const other = s.devices.create(`Other ${n}`, ["read"], 2000 + n);
    const otherProof = await pairingLinkProof(other.token, other.device.id, account, crypto.subtle);
    s.devices.link(account, otherProof, 2000 + n);
  }
  // Its hello again, after all of them.
  s.devices.link(account, proof, 9000);

  const forWorker = capLinked(s.devices.linked(account, 9500), linkedLimit);
  expect(forWorker.ids[0]).toBe(registering.device.id);
});
