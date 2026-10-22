import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, HostId, type FleetOperation } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function connected(daemon: FakeDaemon) {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("window"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  await client.start();
  await ready.promise;
  stop();
  return {
    client,
    ask: async (operation: FleetOperation) =>
      (await client.request({ type: "fleet.request", operation })).result,
  };
}

test("a fake machine keeps links to other machines until they are unlinked", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const { client, ask } = await connected(daemon);
  try {
    const studio = HostId.parse("studio-host");
    const pairingUrl = "https://studio.local:5870/pair#fingerprint=ab&code=ABCD-EFGH&scopes=read";
    expect(await ask({ op: "link", pairingUrl, hostId: studio, name: "Studio" })).toMatchObject({
      kind: "linked",
      link: { hostId: studio, profile: "studio", name: "Studio", status: "online" },
    });
    expect(daemon.services.fleet.links()).toEqual([
      expect.objectContaining({ hostId: studio, access: "operate" }),
    ]);
    expect(await ask({ op: "links" })).toMatchObject({ links: [{ hostId: studio }] });
    expect(await ask({ op: "unlink", hostId: studio })).toEqual({ kind: "unlinked" });
    expect(daemon.services.fleet.links()).toEqual([]);
  } finally {
    await client.close();
  }
});

test("a fake machine's pairing links name, list, cancel and expire like the daemon's", async () => {
  let now = 1000;
  const daemon = new FakeDaemon({ clock: () => now });
  const { client, ask } = await connected(daemon);
  try {
    const labelled = await ask({
      op: "pairing",
      scopes: ["read"],
      label: "Kitchen iPad",
      deviceTtlMs: 24 * 60 * 60_000,
    });
    if (labelled.kind !== "pairing") throw new Error("No pairing");
    expect(new URL(labelled.url).hash).toContain(`code=${labelled.code}`);
    const cancelled = await ask({ op: "pairing", scopes: ["read", "operate"] });
    if (cancelled.kind !== "pairing") throw new Error("No pairing");
    const pending = await ask({ op: "pairings" });
    expect(pending).toMatchObject({
      pairings: [
        { id: labelled.id, label: "Kitchen iPad" },
        { id: cancelled.id, scopes: ["read", "operate"] },
      ],
    });
    expect(JSON.stringify(pending)).not.toContain(labelled.code);
    expect(await ask({ op: "cancelPairing", id: cancelled.id })).toEqual({
      kind: "pairingCancelled",
    });

    // Redeeming the labelled link pairs a device by its label, which lapses after a day.
    const fragment = new URLSearchParams(new URL(labelled.url).hash.slice(1));
    const redeemed = await daemon.access.fetch("https://studio.local/v1/pair", {
      method: "POST",
      body: JSON.stringify({ code: fragment.get("code"), name: "iPad" }),
    });
    expect(await redeemed.json()).toMatchObject({
      device: { name: "Kitchen iPad", expiresAt: 1000 + 24 * 60 * 60_000 },
    });
    expect(await ask({ op: "pairings" })).toEqual({ kind: "pairings", pairings: [] });

    // A five-minute link drops off the list once five minutes pass.
    await ask({ op: "pairing", scopes: ["read"] });
    now += 10 * 60_000;
    expect(await ask({ op: "pairings" })).toEqual({ kind: "pairings", pairings: [] });

    expect(await ask({ op: "revokeOthers" })).toMatchObject({ kind: "revoked", count: 3 });
    expect(await ask({ op: "devices" })).toEqual({ kind: "devices", devices: [] });
  } finally {
    await client.close();
  }
});
