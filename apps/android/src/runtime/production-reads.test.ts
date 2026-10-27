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
const THREAD2 = "thread-2";

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

function daemonBridge(): ExpoPinnedBridge {
  return {
    pinnedFetch: async (input) => {
      if (input.method === "POST" && input.path === "/v1/pair")
        return {
          status: 200,
          body: JSON.stringify({
            device: {
              id: "device-1",
              name: "My phone",
              scopes: ["read", "operate"],
              createdAt: 1,
              lastSeenAt: 1,
              revokedAt: null,
            },
            token: TOKEN,
          }),
        };
      if (input.path === "/v1/tickets")
        return {
          status: 200,
          body: JSON.stringify({ ticket: TICKET, expiresAt: Date.now() + 60_000 }),
        };
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

function liveStartup(daemon: FakeDaemon) {
  const database = memoryDatabase();
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database,
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
  return produced;
}

async function pairLive(daemon: FakeDaemon) {
  const produced = liveStartup(daemon);
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  const confirmed = preparePairing(LINK);
  await produced.pair(confirmed, "My phone");
  expect(produced.canOperate("host-1")).toBe(true);
  return produced;
}

const archive = { type: "thread.archive", threadId: ThreadId.parse(THREAD) } as const;

it("reads live inbox and thread selections through the handle, view-only included", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    reads.check();
    await until(() => reads.connectionState().getSnapshot() === "ready");

    // The daemon's thread lands in the live sidebar selection. Hold one
    // lease while waiting: releasing and re-taking per poll would churn the
    // subscription before the snapshot lands.
    const inboxLease = reads.threads();
    try {
      await until(() => inboxLease.store.ids.includes(THREAD));
      expect(inboxLease.store.thread(THREAD)?.title).toBe("T");
    } finally {
      inboxLease.release();
    }

    // One live thread lease paints its rows.
    {
      const lease = reads.thread(THREAD);
      try {
        await until(() => lease.store.thread !== undefined);
        expect(lease.store.thread?.id).toBe(THREAD);
      } finally {
        lease.release();
      }
    }
    expect(reads.cachedThreads()?.ids).toContain(THREAD);
    expect(reads.cachedThread(THREAD)?.thread?.id).toBe(THREAD);

    // A receipt admitted while operate stays readable through the read handle.
    // Archive a second thread so the inbox row asserted above stays put.
    daemon.createThread({ id: THREAD2, workspaceId: "ace", title: "T2", provider: "codex" });
    const archive2 = { type: "thread.archive", threadId: ThreadId.parse(THREAD2) } as const;
    const gate = produced.runtimeForMutation("host-1");
    const id = await gate.enqueue(archive2);
    await until(() => gate.intent(id).getSnapshot()?.state === "acked");
    expect(reads.intent(id).getSnapshot()?.state).toBe("acked");

    // Revocation keeps every read working while mutations fail closed.
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    reads.check();
    {
      const lease = reads.threads();
      try {
        await until(() => lease.store.ids.includes(THREAD));
      } finally {
        lease.release();
      }
    }
    {
      const lease = reads.thread(THREAD);
      try {
        expect(lease.store.thread?.id).toBe(THREAD);
      } finally {
        lease.release();
      }
    }
    expect(reads.intent(id).getSnapshot()?.state).toBe("acked");
    await expect(gate.enqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
  } finally {
    await produced.disconnectAll();
  }
});

it("the read handle exposes selections only, with no mutation or raw-client bypass", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1") as unknown as Record<string, unknown>;
    expect(Object.keys(reads).toSorted()).toEqual(
      [
        "cachedThread",
        "cachedThreads",
        "check",
        "connectionState",
        "error",
        "hostId",
        "intent",
        "networkOnline",
        "reconnectNow",
        "thread",
        "threads",
        "wake",
      ].toSorted(),
    );
    for (const key of [
      "enqueue",
      "command",
      "submitNew",
      "mutations",
      "client",
      "close",
      "start",
      "threadsWindow",
      "threadsMore",
      "loadOlder",
      "itemsWindow",
      "markThreadRead",
      "request",
      "send",
      "registry",
    ]) {
      expect(reads[key], `reads[${key}]`).toBeUndefined();
      expect(key in (reads as object), `reads has ${key}`).toBe(false);
    }

    // The manager's live runtime stays lifecycle-only: no reads to bypass the
    // handle's exact-owner pin, and no command admission at all.
    const raw = produced.manager.client("host-1") as unknown as Record<string, unknown>;
    for (const key of [
      "threads",
      "thread",
      "cachedThreads",
      "cachedThread",
      "connectionState",
      "intent",
      "enqueue",
      "command",
      "submitNew",
    ]) {
      expect(raw[key], `runtime[${key}]`).toBeUndefined();
      expect(key in raw, `runtime has ${key}`).toBe(false);
    }

    // Extracted read methods still re-resolve: they cannot outlive the owner.
    const handle = produced.runtimeForReading("host-1");
    await until(() => handle.connectionState().getSnapshot() === "ready");
    const cachedThreads = handle.threads;
    const cachedThread = handle.thread;
    const cachedIntent = handle.intent;
    const cachedConnection = handle.connectionState;
    {
      const lease = cachedThreads();
      try {
        await until(() => lease.store.ids.includes(THREAD));
      } finally {
        lease.release();
      }
    }
    expect(typeof cachedConnection().getSnapshot()).toBe("string");
    expect(cachedIntent("missing")?.getSnapshot()).toBeUndefined();
    {
      const lease = cachedThread(THREAD);
      try {
        expect(lease.store.thread?.id ?? THREAD).toBe(THREAD);
      } finally {
        lease.release();
      }
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("a cached read handle fails after disconnect and removal, and stays readable when revoked", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  const cached = produced.runtimeForReading("host-1");
  await until(() => cached.connectionState().getSnapshot() === "ready");
  cached.check();

  await produced.disconnectAll();
  expect(() => cached.check()).toThrow("not connected");
  expect(() => cached.connectionState()).toThrow("not connected");
  expect(() => cached.threads()).toThrow("not connected");
  expect(() => cached.thread(THREAD)).toThrow("not connected");
  expect(() => cached.cachedThreads()).toThrow("not connected");
  expect(() => cached.cachedThread(THREAD)).toThrow("not connected");
  expect(() => cached.intent("anything")).toThrow("not connected");
  expect(() => cached.error).toThrow("not connected");

  // Unknown hosts never resolve a handle.
  expect(() => produced.runtimeForReading("unknown-host")).toThrow("not connected");

  const daemon2 = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced2 = await pairLive(daemon2);
  try {
    const live = produced2.runtimeForReading("host-1");
    await until(() => live.connectionState().getSnapshot() === "ready");
    await produced2.grants.setScopes("device-1", ["read"]);
    // View-only revocation is not a liveness failure: the cached handle reads on.
    live.check();
    {
      const lease = live.threads();
      try {
        await until(() => lease.store.ids.includes(THREAD));
      } finally {
        lease.release();
      }
    }
    await produced2.remove("host-1");
    expect(() => live.threads()).toThrow("not connected");
    expect(() => live.intent("anything")).toThrow("not connected");
  } finally {
    await produced2.disconnectAll();
  }
});

it("a stale read handle fails after same-host replacement instead of following the new owner", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const live = produced.manager.entry("host-1");
    expect(live?.target.kind).toBe("direct");
    const url = live?.target.kind === "direct" ? live.target.url : "";
    const stale = produced.runtimeForReading("host-1");
    await until(() => stale.connectionState().getSnapshot() === "ready");
    stale.check();

    const { MachineEntry } = await import("@ace/client/machines");
    const replacement = MachineEntry.parse({
      hostId: "host-1",
      displayName: "host-1",
      target: { kind: "direct", url, fingerprint: "8e".repeat(32) },
      deviceId: "device-1",
    });
    await produced.manager.connectEntry(replacement);

    expect(() => stale.check()).toThrow("not connected");
    expect(() => stale.connectionState()).toThrow("not connected");
    expect(() => stale.threads()).toThrow("not connected");
    expect(() => stale.thread(THREAD)).toThrow("not connected");
    expect(() => stale.intent("anything")).toThrow("not connected");

    const fresh = produced.runtimeForReading("host-1");
    fresh.check();
    expect(fresh.connectionState().getSnapshot()).not.toBe("ready");
  } finally {
    await produced.disconnectAll();
  }
});
