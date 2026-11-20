import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostId, type MachineDescription } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { Store } from "../store.ts";
import { pairingKey, recordDescription } from "./descriptions.ts";
import { ParcelRows } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function rows() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-descriptions-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "events.sqlite"));
  cleanup.push(async () => store.close());
  return new ParcelRows(store);
}

/** A machine linked on its address only, as `studio`. */
const studio = (token: string, deviceId = "device-laptop") =>
  RemoteProfile.parse({
    id: "00000000-0000-4000-8000-000000000003",
    name: "studio",
    origin: "https://192.168.1.4:7443/",
    fingerprint: "a".repeat(64),
    deviceId,
    token,
  });
const naming = (relayHostId: string): MachineDescription => ({
  hostId: HostId.parse("host-studio"),
  name: "Studio",
  access: "operate",
  projects: [],
  tools: [],
  providers: [],
  paths: [{ kind: "relay", url: "wss://relay.example.com", relayHostId }],
});
const keyOne = "A".repeat(52);
const keyTwo = "B".repeat(52);

describe("what a machine says it serves is kept for the pairing that asked", () => {
  it("enrolls the relay key a LAN-linked pairing's first answer names, durably", async () => {
    const parcels = await rows();
    const pairing = studio("c".repeat(64));
    recordDescription(parcels, [pairing], pairing, naming(keyOne), 1);
    expect(parcels.pins(pairing.id, pairingKey(pairing))).toEqual({ relay: keyOne });
  });
  it("keeps nothing from an answer that comes after its pairing was replaced under the same name", async () => {
    const parcels = await rows();
    const old = studio("c".repeat(64));
    const replacement = studio("d".repeat(64));
    // The old pairing's describe was in flight while `studio` was linked again.
    recordDescription(parcels, [replacement], old, naming(keyOne), 1);
    expect(parcels.pins(replacement.id, pairingKey(replacement))).toEqual({});
    expect(parcels.paths(replacement.id)).toBeUndefined();
    // The replacement's own answer then enrolls its own key.
    recordDescription(parcels, [replacement], replacement, naming(keyTwo), 2);
    expect(parcels.pins(replacement.id, pairingKey(replacement))).toEqual({ relay: keyTwo });
  });
  it("starts over for a pairing linked again with a new credential, the device id unchanged", async () => {
    const parcels = await rows();
    const first = studio("c".repeat(64));
    recordDescription(parcels, [first], first, naming(keyOne), 1);
    const again = studio("d".repeat(64));
    expect(parcels.pins(again.id, pairingKey(again))).toEqual({});
    recordDescription(parcels, [again], again, naming(keyTwo), 2);
    expect(parcels.pins(again.id, pairingKey(again))).toEqual({ relay: keyTwo });
  });
});
