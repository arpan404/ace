import { describe, expect, test } from "vitest";
import { MachineDirectory, machineSecretKey } from "@ace/client/machines";
import { DeviceId, HostIdentity } from "@ace/protocol";
import { performAccess, type PairingDeps } from "./pairing.ts";
import type { PinnedRequest } from "./access.ts";

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

function harness(options: { identity?: () => Promise<typeof identity>; scopes?: string[] } = {}) {
  let saved: string | null = null;
  const secrets = new Map<string, string>();
  const requests: PinnedRequest[] = [];
  let redemptions = 0;
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
    http: async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: JSON.stringify({ device: device(`device-${++redemptions}`, options.scopes), token }),
      };
    },
    directory,
    identity: options.identity ?? (async () => identity),
  };
  return { deps, secrets, requests, saved: () => saved };
}
const pair = {
  op: "pair",
  code: "1".repeat(64),
  name: "Phone",
  url: "wss://100.64.0.7:4243/",
  fingerprint,
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
    expect(saved()).not.toContain(pair.code);
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
    const { deps } = harness({ scopes: ["read"] });
    const result = await performAccess(deps, pair);
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
    const again = await performAccess(deps, { ...pair, code: "2".repeat(64) });
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

  test("a link with a malformed pin is rejected before any request", async () => {
    const { deps, requests } = harness();
    const result = await performAccess(deps, { ...pair, fingerprint: "not-a-pin" });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
