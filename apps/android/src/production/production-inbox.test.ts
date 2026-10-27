import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { Storage } from "@ace/client";
import { createProductionStartup, type StartupDatabase } from "../runtime/production-startup.ts";
import {
  INBOX_LIST_MAX_HEIGHT,
  INBOX_LIST_MIN_HEIGHT,
  MAX_AUTO_RECOVER_ATTEMPTS,
  PRODUCTION_THREAD_WINDOW,
  THREAD_LIST_MAX_HEIGHT,
  THREAD_LIST_MIN_HEIGHT,
  inboxEntriesFor,
  inboxThreadsFor,
  noUndefinedList,
  openIdForRoute,
  readingFailureCopy,
  resolveOpenIdForHost,
  retryReading,
  routeKeyFor,
  shouldAutoRecoverReads,
  shouldResolveLease,
  shouldShowInbox,
  threadHeadlineFor,
  threadWindowFor,
  visibleBlockItemIds,
  windowBlocksFor,
} from "./production-inbox.ts";
import type { Block } from "@ace/ui-core/transcript-blocks";

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

it("bounds auto-recovery so a persistently dead lease waits for Retry", () => {
  expect(MAX_AUTO_RECOVER_ATTEMPTS).toBeGreaterThan(0);
  expect(shouldAutoRecoverReads(true, "ready", 0)).toBe(true);
  expect(shouldAutoRecoverReads(true, "ready", MAX_AUTO_RECOVER_ATTEMPTS - 1)).toBe(true);
  expect(shouldAutoRecoverReads(true, "ready", MAX_AUTO_RECOVER_ATTEMPTS)).toBe(false);
  expect(shouldAutoRecoverReads(true, "ready", MAX_AUTO_RECOVER_ATTEMPTS + 10)).toBe(false);
  // A manual Retry resets the budget by passing 0 again.
  expect(shouldAutoRecoverReads(true, "ready", 0)).toBe(true);
});

it("keeps route identity stable across fresh-per-read route objects", () => {
  const first = routeKeyFor({ route: "paired" });
  const second = routeKeyFor({ route: "paired" });
  expect(first).toBe(second);
  const revokedA = routeKeyFor({
    route: "pairing",
    reason: "revoked",
    message: "This machine needs pairing again.",
  });
  const revokedB = routeKeyFor({
    route: "pairing",
    reason: "revoked",
    message: "This machine needs pairing again.",
  });
  expect(revokedA).toBe(revokedB);
  expect(routeKeyFor({ route: "paired" })).not.toBe(revokedA);
});

it("never resolves or retains a lease for missing or unsupported routes either", () => {
  expect(
    shouldResolveLease({
      route: "pairing",
      reason: "missing",
      message: "Pair this machine.",
    }),
  ).toBe(false);
  expect(
    shouldResolveLease({
      route: "pairing",
      reason: "unsupported",
      message: "Update the computer app.",
    }),
  ).toBe(false);
});

it("closes the open thread for every non-paired route", () => {
  const reasons = ["missing", "revoked", "pin", "unsupported"] as const;
  for (const reason of reasons) {
    expect(openIdForRoute("thread-1", { route: "pairing", reason, message: "m" })).toBe(null);
  }
  expect(openIdForRoute("thread-1", { route: "paired" })).toBe("thread-1");
  expect(openIdForRoute(null, { route: "paired" })).toBe(null);
});

it("keeps one route key per reason so message edits never re-resolve the lease", () => {
  const revokedA = routeKeyFor({
    route: "pairing",
    reason: "revoked",
    message: "one",
  });
  const revokedB = routeKeyFor({
    route: "pairing",
    reason: "revoked",
    message: "two",
  });
  expect(revokedA).toBe(revokedB);
  const reasons = ["missing", "revoked", "pin", "unsupported"] as const;
  const keys = new Set(
    reasons.map((reason) => routeKeyFor({ route: "pairing", reason, message: "m" })),
  );
  expect(keys.size).toBe(reasons.length);
  expect(keys.has(routeKeyFor({ route: "paired" }))).toBe(false);
});

it("fails closed on any not-connected wording, generic copy otherwise", () => {
  expect(readingFailureCopy(new Error("NOT CONNECTED"))).toBe("This machine is not connected.");
  expect(readingFailureCopy(new Error("socket not connected: reset"))).toBe(
    "This machine is not connected.",
  );
  expect(readingFailureCopy("not connected")).toBe("Threads could not be loaded.");
  expect(readingFailureCopy(null)).toBe("Threads could not be loaded.");
});

it("keeps only the latest thread rows under a custom limit", () => {
  const window = threadWindowFor(["a", "b", "c", "d"], 2);
  expect([...window.shown]).toEqual(["c", "d"]);
  expect(window.total).toBe(4);
  expect(window.truncated).toBe(2);
});

it("keeps only windowed blocks and renders only shown items inside a boundary block", () => {
  const blocks: Block[] = [
    { kind: "user", key: "u1", itemId: "a" },
    { kind: "message", key: "m1", itemId: "b" },
    { kind: "work", key: "w1", itemIds: ["b", "c", "d"] },
    { kind: "end", key: "e1", ending: "failed", runId: undefined, askId: undefined },
  ];
  const shown = ["c", "d"];
  const kept = windowBlocksFor(blocks, shown);
  expect(kept.map((block) => block.key)).toEqual(["w1", "e1"]);
  expect(visibleBlockItemIds(blocks[2]!, shown)).toEqual(["c", "d"]);
  expect(visibleBlockItemIds(blocks[1]!, shown)).toEqual([]);
  expect(windowBlocksFor(blocks, new Set(shown)).map((block) => block.key)).toEqual(["w1", "e1"]);
});

it("drops fully evicted dividers before the window and keeps tail dividers positionally", () => {
  const blocks: Block[] = [
    { kind: "end", key: "e0", ending: "failed", runId: undefined, askId: undefined },
    { kind: "user", key: "u1", itemId: "old" },
    { kind: "message", key: "m1", itemId: "new" },
  ];
  // e0 closes a fully evicted turn before the first kept block: it drops.
  expect(windowBlocksFor(blocks, ["new"]).map((block) => block.key)).toEqual(["m1"]);
  expect(windowBlocksFor([], ["new"])).toEqual([]);
  // An item-less divider at/after the first kept block stays with the tail.
  const tail: Block[] = [
    { kind: "user", key: "u1", itemId: "new" },
    { kind: "end", key: "e1", ending: "failed", runId: undefined, askId: undefined },
  ];
  expect(windowBlocksFor(tail, ["new"]).map((block) => block.key)).toEqual(["u1", "e1"]);
  // With no kept content, only live survives.
  const lonely: Block[] = [
    { kind: "end", key: "e0", ending: "failed", runId: undefined, askId: undefined },
    { kind: "live", key: "live:1", askId: undefined },
  ];
  expect(windowBlocksFor(lonely, ["new"]).map((block) => block.key)).toEqual(["live:1"]);
});

it("keeps an end divider through its turn work ids while the turn is in view", () => {
  const blocks: Block[] = [
    { kind: "user", key: "u1", itemId: "a" },
    {
      kind: "end",
      key: "e1",
      ending: "failed",
      runId: "run-1",
      askId: "a",
      itemIds: ["a", "b"],
    },
    { kind: "message", key: "m1", itemId: "c" },
  ];
  expect(windowBlocksFor(blocks, ["b", "c"]).map((block) => block.key)).toEqual(["e1", "m1"]);
  expect(windowBlocksFor(blocks, ["c"]).map((block) => block.key)).toEqual(["m1"]);
});

it("keeps a pending question on an evicted anchor and drops it once closed", () => {
  const blocks: Block[] = [
    {
      kind: "question",
      key: "question:q1",
      interactionId: "q1",
      anchorId: "old",
    },
    { kind: "message", key: "m1", itemId: "new" },
  ];
  expect(
    windowBlocksFor(blocks, ["new"], new Set(["q1"])).map((block) => block.key),
  ).toEqual(["question:q1", "m1"]);
  expect(windowBlocksFor(blocks, ["new"]).map((block) => block.key)).toEqual(["m1"]);
});

it("returns a cached quiet-lines fallback so dead pins never churn useSyncExternalStore", () => {
  expect(noUndefinedList.getSnapshot()).toBe(noUndefinedList.getSnapshot());
  expect(Object.isFrozen(noUndefinedList.getSnapshot())).toBe(true);
});

it("never resolves or retains a lease for a revoked route, even on direct mount", () => {
  expect(shouldResolveLease({ route: "paired" })).toBe(true);
  expect(
    shouldResolveLease({
      route: "pairing",
      reason: "revoked",
      message: "This machine needs pairing again.",
    }),
  ).toBe(false);
  expect(
    shouldResolveLease({
      route: "pairing",
      reason: "pin",
      message: "This computer's identity doesn't match the pairing link. Nothing was sent.",
    }),
  ).toBe(false);
});

it("bounds the inbox and thread lists so small screens scroll instead of clipping", () => {
  expect(INBOX_LIST_MIN_HEIGHT).toBeGreaterThan(0);
  expect(INBOX_LIST_MAX_HEIGHT).toBeGreaterThanOrEqual(INBOX_LIST_MIN_HEIGHT);
  expect(INBOX_LIST_MAX_HEIGHT).toBeLessThanOrEqual(640);
  expect(THREAD_LIST_MIN_HEIGHT).toBeGreaterThan(0);
  expect(THREAD_LIST_MAX_HEIGHT).toBeGreaterThanOrEqual(THREAD_LIST_MIN_HEIGHT);
  expect(THREAD_LIST_MAX_HEIGHT).toBeLessThanOrEqual(640);
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
