import { expect, it } from "vitest";
import { ClientError, type Storage } from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { GrantsPersistence } from "./production-startup.ts";
import {
  assertCanOperate,
  createGrantStore,
  createProductionStartup,
  startupRoute,
  ViewOnlyError,
  type StartupDatabase,
} from "./production-startup.ts";
import { namespaceFor } from "./production-runtime.ts";

const PIN = "9f".repeat(32);
const PIN2 = "ab".repeat(32);
const TOKEN = "e0".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const SOCKET_URL = "wss://192.168.1.20:4243/";

function credential() {
  return {
    device: {
      id: "device-1",
      name: "My phone",
      scopes: ["read", "operate"],
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    },
    token: TOKEN,
  };
}

function memoryStorage(): Storage {
  const meta = new Map<string, string>();
  const records = new Map<string, string>();
  return {
    load: async () => meta.get("legacy") ?? null,
    save: async (value) => {
      meta.set("legacy", value);
    },
    hostBinding: {
      load: async () => meta.get("host") ?? null,
      save: async (value) => {
        meta.set("host", value);
      },
    },
    records: {
      load: async () => [...records.values()],
      write: async (id, value) => {
        if (value === null) records.delete(id);
        else records.set(id, value);
      },
    },
  };
}

function memoryDatabase(): StartupDatabase & {
  namespaces: Map<string, { meta: Map<string, string>; records: Map<string, string> }>;
  grantsSaved: (Record<string, string[]> | null)[];
} {
  const namespaces = new Map<string, { meta: Map<string, string>; records: Map<string, string> }>();
  const grantsSaved: (Record<string, string[]> | null)[] = [];
  let grants: Record<string, string[]> | null = null;
  return {
    namespaces,
    grantsSaved,
    ensureOutboxTables: async () => {},
    deleteNamespace: async (namespace) => {
      namespaces.delete(namespace);
    },
    storageFor: (namespace) => {
      let scope = namespaces.get(namespace);
      if (scope === undefined) {
        scope = { meta: new Map(), records: new Map() };
        namespaces.set(namespace, scope);
      }
      return {
        load: async () => scope.meta.get("legacy") ?? null,
        save: async (value) => {
          scope.meta.set("legacy", value);
        },
        hostBinding: {
          load: async () => scope.meta.get("host") ?? null,
          save: async (value) => {
            scope.meta.set("host", value);
          },
        },
        records: {
          load: async () => [...scope.records.values()],
          write: async (id, value) => {
            if (value === null) scope.records.delete(id);
            else scope.records.set(id, value);
          },
        },
      };
    },
    grants: {
      load: async () => grants,
      save: async (next) => {
        grants = structuredClone(next);
        grantsSaved.push(structuredClone(next));
      },
    } satisfies GrantsPersistence,
  };
}

function pairingBridge(): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.method === "POST" && input.path === "/v1/pair")
        return { status: 200, body: JSON.stringify(credential()) };
      return { status: 404, body: "{}" };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

function startup() {
  const database = memoryDatabase();
  const produced = createProductionStartup({
    bridge: pairingBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database,
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    clocks: {
      scheduler: { set: () => () => {} },
      id: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      random: () => 0.5,
      now: () => 1_000,
    },
  });
  return { produced, database };
}

it("treats unknown and missing grants as view-only and never defaults to operate", async () => {
  const grants = createGrantStore();
  await grants.load();
  // No row recorded: an unknown device cannot operate, even though iOS
  // still defaults unknown devices to operate. This boundary fails closed.
  expect(grants.scopesFor("new-device")).toEqual([]);
  expect(grants.canOperateFor("new-device")).toBe(false);
  expect(() => assertCanOperate(grants, { deviceId: "new-device" })).toThrow(ViewOnlyError);
  await grants.setScopes("view-device", ["read"]);
  expect(grants.canOperateFor("view-device")).toBe(false);
  expect(() => assertCanOperate(grants, { deviceId: "view-device" })).toThrow(ViewOnlyError);
  // operate and admin both act; an empty grant list cannot.
  await grants.setScopes("operate-device", ["operate"]);
  await grants.setScopes("admin-device", ["admin"]);
  await grants.setScopes("empty-device", []);
  expect(grants.canOperateFor("operate-device")).toBe(true);
  expect(grants.canOperateFor("admin-device")).toBe(true);
  expect(grants.canOperateFor("empty-device")).toBe(false);
  assertCanOperate(grants, { deviceId: "operate-device" });
});

it("gates per-machine mutations behind the recorded grant and fails closed", async () => {
  const { produced } = startup();
  expect(await produced.load()).toEqual([]);
  expect(produced.canOperate("host-1")).toBe(false);
  expect(() => produced.assertCanOperateFor("host-1")).toThrow(ViewOnlyError);
  const confirmed = preparePairing(LINK);
  const entry = await produced.pair(confirmed, "My phone");
  expect(entry.hostId).toBe("host-1");
  expect(produced.canOperate("host-1")).toBe(true);
  await produced.grants.setScopes("device-1", ["read"]);
  expect(produced.canOperate("host-1")).toBe(false);
  expect(() => produced.assertCanOperateFor("host-1")).toThrow(ViewOnlyError);
  await produced.disconnectAll();
});

it("admits only operate grants to mutating gates and re-checks every use", async () => {
  const { produced } = startup();
  expect(await produced.load()).toEqual([]);
  // Unknown hosts fail closed, even for mutations.
  expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  const raw = produced.manager.client("host-1");
  expect(raw).toBeDefined();
  const first = produced.runtimeForMutation("host-1");
  // The gate is a fresh short-lived object, never the shared raw runtime:
  // caching it cannot bypass later checks.
  expect(first).not.toBe(raw);
  expect(produced.runtimeForMutation("host-1")).not.toBe(first);
  first.check();
  // Read-only rows stay readable for view-only grants; mutations do not.
  await produced.grants.setScopes("device-1", ["read"]);
  expect(produced.route("host-1")).toEqual({ route: "paired" });
  // A gate cached while operate was granted stops at first use after revoke.
  expect(() => first.check()).toThrow(ViewOnlyError);
  expect(() => first.reconnectNow()).toThrow(ViewOnlyError);
  expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
  // Restoring the grant re-admits with a fresh gate.
  await produced.grants.setScopes("device-1", ["read", "operate"]);
  produced.runtimeForMutation("host-1").check();
  await produced.disconnectAll();
  // An operate grant with no live runtime is a connectivity error, never a
  // silent pass: mutations need both admission and a connection, even cached.
  expect(() => first.check()).toThrow("not connected");
  expect(() => produced.runtimeForMutation("host-1")).toThrow("not connected");
});

it("fails a cached gate after the machine is removed", async () => {
  const { produced } = startup();
  expect(await produced.load()).toEqual([]);
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  const cached = produced.runtimeForMutation("host-1");
  cached.check();
  await produced.remove("host-1");
  expect(() => cached.check()).toThrow(ViewOnlyError);
  expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
  await produced.disconnectAll();
});

it("scopes trust by machine identity and drops it on remove", async () => {
  const { produced } = startup();
  expect(await produced.load()).toEqual([]);
  const confirmed = preparePairing(LINK);
  const entry = await produced.pair(confirmed, "My phone");

  // A pin failure sticks while the binding is unchanged and routes to pairing.
  const first = produced.trustOf(entry);
  first.report("pin");
  expect(produced.trustOf(entry)).toBe(first);
  expect(produced.route("host-1")).toMatchObject({ route: "pairing", reason: "pin" });

  // A new pin for the same host is a new identity: it must not inherit the
  // old failure (re-pairing after a pin rotation starts clean).
  const repinned = MachineEntry.parse({
    ...entry,
    target: { kind: "direct", url: SOCKET_URL, fingerprint: PIN2 },
  });
  const second = produced.trustOf(repinned);
  expect(second).not.toBe(first);
  expect(second.failure).toBeUndefined();

  // The old binding reads fresh again afterwards: stale failures never
  // persist across an identity change in either direction.
  const revived = produced.trustOf(entry);
  expect(revived).not.toBe(first);
  expect(revived.failure).toBeUndefined();
  expect(produced.route("host-1")).toEqual({ route: "paired" });

  // Removal drops the report with the runtime: re-pairing the same host id
  // (same pin and device) starts clean.
  produced.trustOf(entry).report("pin");
  expect(produced.route("host-1")).toMatchObject({ route: "pairing", reason: "pin" });
  await produced.remove("host-1");
  expect(produced.route("host-1")).toMatchObject({ route: "pairing", reason: "missing" });
  expect(produced.trustOf(entry).failure).toBeUndefined();

  // Directory prune drops reports for machines the directory no longer
  // lists, even when nothing was explicitly removed through this boundary.
  const stranger = MachineEntry.parse({
    hostId: "host-9",
    displayName: "host-9",
    target: { kind: "direct", url: SOCKET_URL, fingerprint: PIN },
    deviceId: "phone-9",
  });
  produced.trustOf(stranger).report("pin");
  expect(await produced.load()).toEqual([]);
  expect(produced.trustOf(stranger).failure).toBeUndefined();
  await produced.disconnectAll();
});

it("persists grants across loads and drops malformed rows", async () => {
  let saved: Record<string, string[]> | null = null;
  const persistence: GrantsPersistence = {
    load: async () => saved,
    save: async (next) => {
      saved = next;
    },
  };
  const first = createGrantStore(persistence);
  await first.load();
  await first.setScopes("device-1", ["read", "projects"]);
  const second = createGrantStore(persistence);
  await second.load();
  expect(second.scopesFor("device-1")).toEqual(["read", "projects"]);
  saved = { "device-1": ["read"], broken: "not-an-array" } as unknown as Record<string, string[]>;
  const third = createGrantStore(persistence);
  await third.load();
  // Malformed rows fail closed: every device reads as unknown (view-only).
  expect(third.scopesFor("device-1")).toEqual([]);
  expect(third.canOperateFor("device-1")).toBe(false);
});

it("routes missing, unsupported, revoked and pin-mismatched machines to pairing", () => {
  expect(startupRoute({ entry: undefined })).toMatchObject({ route: "pairing", reason: "missing" });
  const relay = MachineEntry.parse({
    hostId: "host-1",
    displayName: "host-1",
    target: { kind: "relay", url: SOCKET_URL, ticketReference: "ref" },
    deviceId: "phone-1",
  });
  expect(startupRoute({ entry: relay })).toMatchObject({ route: "pairing", reason: "unsupported" });
  const direct = MachineEntry.parse({
    hostId: "host-1",
    displayName: "host-1",
    target: { kind: "direct", url: SOCKET_URL, fingerprint: PIN },
    deviceId: "phone-1",
  });
  expect(startupRoute({ entry: direct, trustFailure: "pin" })).toMatchObject({
    route: "pairing",
    reason: "pin",
  });
  expect(startupRoute({ entry: direct, failure: new ClientError("auth") })).toMatchObject({
    route: "pairing",
    reason: "revoked",
  });
  expect(startupRoute({ entry: direct, failure: new ClientError("identity") })).toMatchObject({
    route: "pairing",
    reason: "pin",
  });
  expect(
    startupRoute({ entry: direct, failure: new Error("This machine needs pairing again") }),
  ).toMatchObject({
    route: "pairing",
    reason: "revoked",
  });
  // Offline, storage and starting failures stay paired: the SDK keeps retrying.
  expect(startupRoute({ entry: direct, failure: new ClientError("offline") })).toEqual({
    route: "paired",
  });
  expect(startupRoute({ entry: direct, failure: new ClientError("storage") })).toEqual({
    route: "paired",
  });
  expect(startupRoute({ entry: direct })).toEqual({ route: "paired" });
});

it("pairs, records the grant, routes paired, and removes with namespace cleanup", async () => {
  const { produced, database } = startup();
  expect(await produced.load()).toEqual([]);
  expect(produced.route("host-1")).toMatchObject({ route: "pairing", reason: "missing" });

  const confirmed = preparePairing(LINK);
  const entry = await produced.pair(confirmed, "My phone");
  expect(entry.hostId).toBe("host-1");
  expect(produced.grants.scopesFor("device-1")).toEqual(["read", "operate"]);
  expect(produced.grants.canOperateFor("device-1")).toBe(true);
  expect(produced.route("host-1")).toEqual({ route: "paired" });
  expect(await produced.load()).toHaveLength(1);

  // Seed rows in this machine's namespace, then remove: only its namespace goes.
  const scope = namespaceFor({ hostId: "host-1", deviceId: "device-1" });
  const storage = database.storageFor(scope);
  await storage.records?.write("pending-1", "value");
  await produced.remove("host-1");
  expect(produced.manager.entries()).toEqual([]);
  expect(produced.route("host-1")).toMatchObject({ route: "pairing", reason: "missing" });
  expect(database.namespaces.has(scope)).toBe(false);
  // Removal drops the grant row: the device reads as unknown (view-only).
  expect(produced.grants.scopesFor("device-1")).toEqual([]);
  expect(produced.grants.canOperateFor("device-1")).toBe(false);
  await produced.disconnectAll();
});

it("keeps view-only admission separate from routing and the read path", async () => {
  const { produced } = startup();
  expect(await produced.load()).toEqual([]);
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  // Downgrade to view-only: admission refuses, but routing stays paired and
  // the read path stays reachable. The lifecycle gate is not an enforced
  // content-mutation boundary (real mutations are not routed through it).
  await produced.grants.setScopes("device-1", ["read"]);
  expect(() => produced.assertCanOperateFor("host-1")).toThrow(ViewOnlyError);
  expect(produced.route("host-1")).toEqual({ route: "paired" });
  expect(produced.manager.client("host-1")).toBeDefined();
  expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
  // ViewOnlyError is admission-time, never a connection failure: it must not
  // route the machine back to pairing the way auth failures do.
  try {
    produced.assertCanOperateFor("host-1");
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ViewOnlyError);
    expect(error).not.toBeInstanceOf(ClientError);
  }
  await produced.disconnectAll();
});
