import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingLinkProof } from "@ace/client/link-proof";
import { DeviceId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
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
