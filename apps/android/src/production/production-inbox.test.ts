import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { Storage } from "@ace/client";
import { createProductionStartup, type StartupDatabase } from "../runtime/production-startup.ts";
import {
  PRODUCTION_THREAD_WINDOW,
  inboxEntriesFor,
  inboxThreadsFor,
  openIdForRoute,
  readingFailureCopy,
  resolveOpenIdForHost,
  retryReading,
  shouldAutoRecoverReads,
  shouldShowInbox,
  threadHeadlineFor,
  threadWindowFor,
} from "./production-inbox.ts";

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const THREAD = "thread-1";

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

it("shows the inbox only for a paired route", () => {
  expect(shouldShowInbox({ route: "paired" })).toBe(true);
  expect(shouldShowInbox({ route: "pairing", reason: "revoked", message: "Pair again." })).toBe(
    false,
  );
  expect(readingFailureCopy(new Error("This machine is not connected."))).toBe(
    "This machine is not connected.",
  );
  expect(readingFailureCopy(new Error("boom"))).toBe("Threads could not be loaded.");
});

it("lists the active machine's inbox rows through the read-only handle", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({
    id: THREAD,
    workspaceId: "ace",
    title: "T",
    provider: "codex",
    hasSentMessage: true,
  });
  await produced.pair(preparePairing(LINK), "My phone");
  try {
    expect(shouldShowInbox(produced.route("host-1"))).toBe(true);
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const lease = reads.threads();
    try {
      await until(() => lease.store.ids.includes(THREAD));
      const rows = inboxThreadsFor(lease.store, "host-1");
      expect(rows.map((row) => row.key)).toEqual(["host-1:thread-1"]);
      expect(rows[0]?.entry.title).toBe("T");
      const entries = inboxEntriesFor(lease.store, "host-1", Date.now());
      expect(entries.some((entry) => entry.kind === "thread" && entry.id === THREAD)).toBe(true);
    } finally {
      lease.release();
    }
    const threadLease = reads.thread(THREAD);
    try {
      await until(() => threadLease.store.thread !== undefined);
      expect(threadHeadlineFor(threadLease.store).title).toBe("T");
    } finally {
      threadLease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("keeps the inbox readable while view-only, with no mutation surface", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({
    id: THREAD,
    workspaceId: "ace",
    title: "T",
    provider: "codex",
    hasSentMessage: true,
  });
  await produced.pair(preparePairing(LINK), "My phone");
  try {
    const reads = produced.runtimeForReading("host-1") as unknown as Record<string, unknown>;
    for (const key of ["enqueue", "command", "submitNew", "client", "start", "close"]) {
      expect(reads[key], `reads[${key}]`).toBeUndefined();
      expect(key in (reads as object), `reads has ${key}`).toBe(false);
    }
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    expect(shouldShowInbox(produced.route("host-1"))).toBe(true);
    const live = produced.runtimeForReading("host-1");
    const lease = live.threads();
    try {
      await until(() => lease.store.ids.includes(THREAD));
      expect(inboxThreadsFor(lease.store, "host-1")).toHaveLength(1);
    } finally {
      lease.release();
    }
    expect(() => produced.runtimeForReading("unknown-host")).toThrow("not connected");
    expect(() => produced.runtimeForMutation("host-1")).toThrow();
  } finally {
    await produced.disconnectAll();
  }
});

it("fails the inbox closed after disconnect", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({
    id: THREAD,
    workspaceId: "ace",
    title: "T",
    provider: "codex",
    hasSentMessage: true,
  });
  await produced.pair(preparePairing(LINK), "My phone");
  const cached = produced.runtimeForReading("host-1");
  await until(() => cached.connectionState().getSnapshot() === "ready");
  await produced.disconnectAll();
  expect(() => cached.threads()).toThrow("not connected");
  expect(() => cached.thread(THREAD)).toThrow("not connected");
  const unused = ThreadId.parse(THREAD);
  expect(unused).toBe(THREAD);
});

it("states the thread window honestly instead of silently dropping history", () => {
  expect(PRODUCTION_THREAD_WINDOW).toBe(50);
  expect(threadWindowFor([])).toEqual({ shown: [], total: 0, truncated: 0 });
  const three = threadWindowFor(["a", "b", "c"]);
  expect(three.total).toBe(3);
  expect(three.truncated).toBe(0);
  expect([...three.shown]).toEqual(["a", "b", "c"]);
  const order = Array.from({ length: 60 }, (_, index) => `item-${index}`);
  const window = threadWindowFor(order);
  expect(window.total).toBe(60);
  expect(window.truncated).toBe(10);
  expect([...window.shown]).toEqual(order.slice(-50));
  expect(window.shown).not.toContain("item-0");
});

it("resolves the open thread synchronously on host change, never flashing the old owner", () => {
  expect(resolveOpenIdForHost("host-1", "host-1", "thread-1")).toBe("thread-1");
  expect(resolveOpenIdForHost("host-1", "host-1", null)).toBe(null);
  expect(resolveOpenIdForHost("host-1", "host-2", "thread-1")).toBe(null);
});

it("closes the open thread when the route leaves paired", () => {
  expect(openIdForRoute("thread-1", { route: "paired" })).toBe("thread-1");
  expect(openIdForRoute(null, { route: "paired" })).toBe(null);
  expect(
    openIdForRoute("thread-1", {
      route: "pairing",
      reason: "revoked",
      message: "This machine needs pairing again.",
    }),
  ).toBe(null);
  expect(
    openIdForRoute("thread-1", {
      route: "pairing",
      reason: "pin",
      message: "This computer's identity doesn't match the pairing link. Nothing was sent.",
    }),
  ).toBe(null);
});

it("auto-recovers only when the lease is dead and a fresh handle is ready", () => {
  expect(shouldAutoRecoverReads(true, "ready")).toBe(true);
  expect(shouldAutoRecoverReads(true, "connecting")).toBe(false);
  expect(shouldAutoRecoverReads(true, null)).toBe(false);
  expect(shouldAutoRecoverReads(false, "ready")).toBe(false);
});

it("retries through reconnectNow with a wake fallback and never throws", () => {
  const calls: string[] = [];
  retryReading(
    {
      runtimeForReading: () => ({
        reconnectNow: () => {
          calls.push("reconnectNow");
        },
        wake: () => {
          calls.push("wake");
        },
      }),
    },
    "host-1",
  );
  expect(calls).toEqual(["reconnectNow"]);
  const fallback: string[] = [];
  retryReading(
    {
      runtimeForReading: () => ({
        reconnectNow: () => {
          throw new Error("down");
        },
        wake: () => {
          fallback.push("wake");
        },
      }),
    },
    "host-1",
  );
  expect(fallback).toEqual(["wake"]);
  expect(() =>
    retryReading(
      {
        runtimeForReading: () => {
          throw new Error("not connected");
        },
      },
      "host-1",
    ),
  ).not.toThrow();
  expect(() =>
    retryReading(
      {
        runtimeForReading: () => ({
          reconnectNow: () => {
            throw new Error("down");
          },
          wake: () => {
            throw new Error("down");
          },
        }),
      },
      "host-1",
    ),
  ).not.toThrow();
});

it("keeps section headings alongside thread rows for parity with the fixture inbox", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
    identityReader: async () => ({ hostId: "host-1", displayName: "Studio", version: "1.0" }),
    transportFor: () => fakeTransport(daemon),
  });
  expect(await produced.load()).toEqual([]);
  daemon.createThread({
    id: THREAD,
    workspaceId: "ace",
    title: "T",
    provider: "codex",
    hasSentMessage: true,
  });
  await produced.pair(preparePairing(LINK), "My phone");
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const lease = reads.threads();
    try {
      await until(() => lease.store.ids.includes(THREAD));
      const entries = inboxEntriesFor(lease.store, "host-1", Date.now());
      expect(entries.length).toBeGreaterThan(1);
      expect(entries[0]?.kind).toBe("heading");
      expect(entries.some((entry) => entry.kind === "thread" && entry.id === THREAD)).toBe(true);
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});
