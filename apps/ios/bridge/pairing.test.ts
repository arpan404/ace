import { describe, expect, test } from "vitest";
import { MachineDirectory, machineSecretKey } from "@ace/client/machines";
import { DeviceId, HostIdentity } from "@ace/protocol";
import { performAccess, type PairingDeps } from "./pairing.ts";

const token = "b".repeat(64);
const fingerprint = "f".repeat(64);
const identity = HostIdentity.parse({
  hostId: "host-studio",
  displayName: "Studio Mac",
  hostname: "studio.local",
  version: "1.0.0",
});
function device(id: string, scopes = ["read", "operate"]) {
  return { id, name: "Phone", scopes, createdAt: 1, lastSeenAt: 1, revokedAt: null };
}

function harness(options: { identity?: PairingDeps["identity"] } = {}) {
  let saved: string | null = null;
  const secrets = new Map<string, string>();
  const directory = new MachineDirectory(
    {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    {
      get: async (key) => secrets.get(key) ?? null,
      set: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
  );
  const deps: PairingDeps = {
    directory,
    identity: options.identity ?? (async () => identity),
  };
  return { deps, secrets, saved: () => saved };
}
/** Swift redeemed the link itself and hands over only the machine's answer (ADR 0190 §7). */
const redeemed = (id = "device-1", scopes?: string[]) => ({
  status: 200,
  body: JSON.stringify({ device: device(id, scopes), token }),
});
const pair = {
  op: "pair",
  url: "wss://100.64.0.7:4243/",
  fingerprint,
  redeemed: redeemed(),
};

describe("pairing a machine", () => {
  test("the token reaches only the secret store, keyed by the authenticated host and device", async () => {
    const { deps, secrets, saved } = harness();
    const result = await performAccess(deps, pair);
    expect(result).toMatchObject({
      ok: true,
      paired: { hostId: "host-studio", scopes: ["read", "operate"] },
    });
    const key = machineSecretKey({ hostId: identity.hostId, deviceId: DeviceId.parse("device-1") });
    expect(secrets.get(key)).toBe(token);
    expect(saved()).not.toContain(token);
    expect(result.ok && result.machines).toEqual([
      {
        hostId: "host-studio",
        displayName: "Studio Mac",
        deviceId: "device-1",
        target: { kind: "direct", url: pair.url, fingerprint },
      },
    ]);
  });

  test("a read-only grant is reported so the phone can show view-only access", async () => {
    const { deps } = harness();
    const result = await performAccess(deps, { ...pair, redeemed: redeemed("device-1", ["read"]) });
    expect(result.ok && result.paired?.scopes).toEqual(["read"]);
  });

  test("a failed identity read stores no machine and no credential", async () => {
    const { deps, secrets, saved } = harness({
      identity: async () => {
        throw new Error("socket closed");
      },
    });
    const result = await performAccess(deps, pair);
    expect(result.ok).toBe(false);
    expect(secrets.size).toBe(0);
    expect(saved()).toBeNull();
  });

  test("pairing the same computer again is refused and keeps the original credential", async () => {
    const { deps, secrets } = harness();
    await performAccess(deps, pair);
    const again = await performAccess(deps, { ...pair, redeemed: redeemed("device-2") });
    expect(again).toMatchObject({ ok: false, problem: { code: "duplicate" } });
    expect([...secrets.keys()]).toEqual([
      machineSecretKey({ hostId: identity.hostId, deviceId: DeviceId.parse("device-1") }),
    ]);
  });

  test("removing a machine deletes its credential and its directory entry", async () => {
    const { deps, secrets } = harness();
    await performAccess(deps, pair);
    const removed = await performAccess(deps, { op: "remove", hostId: "host-studio" });
    expect(removed).toMatchObject({ ok: true, machines: [] });
    expect(secrets.size).toBe(0);
    expect(await performAccess(deps, { op: "list" })).toMatchObject({ ok: true, machines: [] });
  });

  test("renaming a machine changes only its name; its credential and address stay", async () => {
    const { deps, secrets } = harness();
    await performAccess(deps, pair);
    const renamed = await performAccess(deps, {
      op: "rename",
      hostId: "host-studio",
      name: "  Desk  ",
    });
    expect(renamed).toMatchObject({
      ok: true,
      machines: [{ hostId: "host-studio", displayName: "Desk", target: { url: pair.url } }],
    });
    expect(secrets.size).toBe(1);
    const unknown = await performAccess(deps, { op: "rename", hostId: "elsewhere", name: "X" });
    expect(unknown.ok).toBe(false);
  });

  test("pairing names this app install to the machine in the hello", async () => {
    const helloInstalls: (string | undefined)[] = [];
    const { deps } = harness({
      identity: async (_device, _token, _trust, installId) => {
        helloInstalls.push(installId);
        return identity;
      },
    });
    const installId = "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
    await performAccess(deps, { ...pair, installId });
    expect(helloInstalls).toEqual([installId]);
  });

  test("the script is never handed a pairing code or a standing key to redeem with", async () => {
    const { deps, secrets, saved } = harness();
    for (const extra of [{ code: "1".repeat(64) }, { standingKey: "B".repeat(87) }]) {
      expect(await performAccess(deps, { ...pair, ...extra })).toMatchObject({ ok: false });
    }
    expect(secrets.size).toBe(0);
    expect(saved()).toBeNull();
  });

  test("a redemption the native transport refused stores nothing and says why", async () => {
    const { deps, secrets, saved } = harness();
    const result = await performAccess(deps, { ...pair, redeemed: { refused: "pin" } });
    expect(result).toMatchObject({ ok: false, problem: { code: "pin" } });
    expect(secrets.size).toBe(0);
    expect(saved()).toBeNull();
  });

  test("a paired machine's own word on its paths is saved with it and listed back", async () => {
    const { deps } = harness();
    await performAccess(deps, pair);
    const paths = [
      { kind: "lan", url: "https://192.168.1.4:4243", fingerprint },
      { kind: "tailscale", url: "https://100.64.0.7:4243", fingerprint },
      { kind: "account", url: "wss://relay.example.com", relayHostId: "A".repeat(52) },
    ];
    await performAccess(deps, { op: "remember", hostId: "host-studio", paths });
    expect(await performAccess(deps, { op: "list" })).toMatchObject({
      ok: true,
      machines: [{ hostId: "host-studio", paths }],
    });
  });

  test("a link with a malformed pin pairs nothing", async () => {
    const { deps, saved } = harness();
    const result = await performAccess(deps, { ...pair, fingerprint: "not-a-pin" });
    expect(result.ok).toBe(false);
    expect(saved()).toBeNull();
  });
});
