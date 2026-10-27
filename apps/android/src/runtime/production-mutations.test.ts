import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { Storage } from "@ace/client";
import {
  createProductionStartup,
  ViewOnlyError,
  type StartupDatabase,
} from "./production-startup.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const THREAD = "thread-1";

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

function memoryDatabase(): StartupDatabase {
  const namespaces = new Map<string, { meta: Map<string, string>; records: Map<string, string> }>();
  let grants: Record<string, string[]> | null = null;
  return {
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
      },
    },
  };
}

/** A daemon that accepts the stubbed single-use ticket instead of a token. */
class TicketDaemon extends FakeDaemon {
  override accepts(offered: { token?: string | undefined; ticket?: string | undefined }) {
    return offered.ticket === TICKET;
  }
}

function daemonBridge(seenTokens: string[]): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.method === "POST" && input.path === "/v1/pair")
        return { status: 200, body: JSON.stringify(credential()) };
      if (input.path === "/v1/tickets") {
        if (input.token !== undefined) seenTokens.push(input.token);
        return {
          status: 200,
          body: JSON.stringify({ ticket: TICKET, expiresAt: Date.now() + 60_000 }),
        };
      }
      return { status: 404, body: "{}" };
    },
    pinnedSocketOpen: () => {},
    pinnedSocketSend: () => {},
    pinnedSocketClose: () => {},
    addSocketListener: () => () => {},
  };
}

async function until(
  done: () => boolean,
  message = "Timed out waiting for the daemon.",
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function liveStartup(daemon: FakeDaemon, sent: string[], seenTokens: string[]) {
  const database = memoryDatabase();
  const produced = createProductionStartup({
    bridge: daemonBridge(seenTokens),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database,
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => {
      const inner = fakeTransport(daemon);
      return {
        open: (events) => inner.open(events),
        send: (text) => {
          sent.push(text);
          inner.send(text);
        },
        close: () => inner.close(),
      };
    },
  });
  return { produced, database };
}

async function pairLive(daemon: FakeDaemon, sent: string[], seenTokens: string[]) {
  const { produced } = liveStartup(daemon, sent, seenTokens);
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  expect(produced.canOperate("host-1")).toBe(true);
  return produced;
}

const archive = { type: "thread.archive", threadId: ThreadId.parse(THREAD) } as const;

it("admits real commands through an operate gate and the daemon applies them", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const seenTokens: string[] = [];
  const produced = await pairLive(daemon, sent, seenTokens);
  try {
    const gate = produced.runtimeForMutation("host-1");
    const id = await gate.enqueue(archive);
    await until(() => gate.intent(id).getSnapshot()?.state === "acked");
    expect(sent.some((text) => text.includes("thread.archive"))).toBe(true);

    const receipt = await gate.command(archive);
    expect(receipt.ok).toBe(true);

    const recorded: string[] = [];
    const created = await gate.submitNew(archive, (next) => {
      recorded.push(next);
    });
    expect(created.ok).toBe(true);
    expect(recorded).toHaveLength(1);
  } finally {
    await produced.disconnectAll();
  }
});

it("refuses real commands for view-only grants before touching the network", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const seenTokens: string[] = [];
  const produced = await pairLive(daemon, sent, seenTokens);
  try {
    // The manager's live runtime exposes lifecycle only at runtime, not just in
    // the types: no command admission to bypass through a cast.
    const raw = produced.manager.client("host-1") as unknown as Record<string, unknown>;
    expect(raw["enqueue"]).toBeUndefined();
    expect(raw["command"]).toBeUndefined();
    expect(raw["submitNew"]).toBeUndefined();
    expect(raw["mutations"]).toBeUndefined();
    expect(raw["intent"]).toBeUndefined();
    expect("mutations" in raw).toBe(false);
    expect("enqueue" in raw).toBe(false);
    expect("command" in raw).toBe(false);
    expect("submitNew" in raw).toBe(false);

    const cached = produced.runtimeForMutation("host-1");
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);

    const before = sent.length;
    await expect(cached.enqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(cached.command(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    const recorded: string[] = [];
    await expect(
      cached.submitNew(archive, (next) => {
        recorded.push(next);
      }),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(recorded).toEqual([]);
    expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
    // Nothing reached the wire after revocation.
    expect(sent.slice(before).some((text) => text.includes("thread.archive"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("a cached operate gate stops admitting after removal and disconnect", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const seenTokens: string[] = [];
  const produced = await pairLive(daemon, sent, seenTokens);
  try {
    const cached = produced.runtimeForMutation("host-1");
    cached.check();

    await produced.remove("host-1");
    await expect(cached.enqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(cached.command(archive)).rejects.toBeInstanceOf(ViewOnlyError);
  } finally {
    await produced.disconnectAll();
  }

  const daemon2 = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent2: string[] = [];
  const produced2 = await pairLive(daemon2, sent2, []);
  try {
    const cached = produced2.runtimeForMutation("host-1");
    cached.check();
    await produced2.disconnectAll();
    await expect(cached.enqueue(archive)).rejects.toThrow("not connected");
    await expect(cached.command(archive)).rejects.toThrow("not connected");
    const recorded: string[] = [];
    await expect(
      cached.submitNew(archive, (next) => {
        recorded.push(next);
      }),
    ).rejects.toThrow("not connected");
    expect(recorded).toEqual([]);
  } finally {
    await produced2.disconnectAll();
  }
});

it("extracted gate methods re-check the grant and intent stays readable view-only", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const seenTokens: string[] = [];
  const produced = await pairLive(daemon, sent, seenTokens);
  try {
    const gate = produced.runtimeForMutation("host-1");
    const id = await gate.enqueue(archive);
    await until(() => gate.intent(id).getSnapshot()?.state === "acked");
    // Extract bound handles before revocation: they must still re-resolve.
    const cachedEnqueue = gate.enqueue;
    const cachedCommand = gate.command;
    const cachedSubmitNew = gate.submitNew;
    const cachedIntent = gate.intent;
    await produced.grants.setScopes("device-1", ["read"]);
    await expect(cachedEnqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    await expect(cachedCommand(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    const recorded: string[] = [];
    await expect(
      cachedSubmitNew(archive, (next) => {
        recorded.push(next);
      }),
    ).rejects.toBeInstanceOf(ViewOnlyError);
    expect(recorded).toEqual([]);
    // Read-only receipts need liveness only: still readable while connected.
    expect(cachedIntent(id).getSnapshot()?.state).toBe("acked");
  } finally {
    await produced.disconnectAll();
  }
});

it("a leaked guarded admission cannot outlive revocation or close", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent, []);
  try {
    // No unguarded path through the manager at runtime.
    const raw = produced.manager.client("host-1") as unknown as Record<string, unknown>;
    expect(raw["mutations"]).toBeUndefined();
    // Revoke, then close: every cached entry point fails closed.
    const cached = produced.runtimeForMutation("host-1");
    await produced.grants.setScopes("device-1", ["read"]);
    await expect(cached.enqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    await produced.disconnectAll();
    await expect(cached.enqueue(archive)).rejects.toThrow();
    expect(() => cached.intent("anything")).toThrow("not connected");
  } finally {
    await produced.disconnectAll();
  }
});

it("a stale gate fails after same-host replacement instead of reaching the new owner", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const seenTokens: string[] = [];
  const produced = await pairLive(daemon, sent, seenTokens);
  try {
    const live = produced.manager.entry("host-1");
    expect(live?.target.kind).toBe("direct");
    const url = live?.target.kind === "direct" ? live.target.url : "";
    const stale = produced.runtimeForMutation("host-1");
    stale.check();

    // Same host and device, new pin binding: the manager closes the old
    // runtime before the new one opens, minting a new admission record.
    const { MachineEntry } = await import("@ace/client/machines");
    const replacement = MachineEntry.parse({
      hostId: "host-1",
      displayName: "host-1",
      target: { kind: "direct", url, fingerprint: "8e".repeat(32) },
      deviceId: "device-1",
    });
    await produced.manager.connectEntry(replacement);

    // The cached gate stays pinned to the old record: no forwarding.
    await expect(stale.enqueue(archive)).rejects.toThrow("not connected");
    await expect(stale.command(archive)).rejects.toThrow("not connected");
    const recorded: string[] = [];
    await expect(
      stale.submitNew(archive, (next) => {
        recorded.push(next);
      }),
    ).rejects.toThrow("not connected");
    expect(recorded).toEqual([]);
    expect(() => stale.intent("anything")).toThrow("not connected");

    // A fresh gate resolves the current owner and admits.
    const fresh = produced.runtimeForMutation("host-1");
    fresh.check();
    const id = await fresh.enqueue(archive);
    expect(typeof id).toBe("string");
  } finally {
    await produced.disconnectAll();
  }
});
