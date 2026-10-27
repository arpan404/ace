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

it("projected lease stores expose readers only at runtime, with frozen copies", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const inbox = reads.threads();
    try {
      await until(() => inbox.store.ids.includes(THREAD));
      const store = inbox.store as unknown as Record<string, unknown>;
      expect(Object.getPrototypeOf(store)).toBeNull();
      expect(Object.isFrozen(store)).toBe(true);
      expect(Object.keys(store).toSorted()).toEqual(
        [
          "error",
          "homeWindow",
          "ids",
          "loaded",
          "observe",
          "select",
          "syncing",
          "thread",
          "unconfirmed",
          "window",
        ].toSorted(),
      );
      for (const mutator of [
        "configure",
        "acquire",
        "close",
        "reject",
        "receive",
        "reconnect",
        "disconnect",
        "snapshot",
        "delivery",
        "page",
        "restore",
        "fail",
        "recover",
        "setSyncing",
        "setUnconfirmed",
        "export",
        "send",
      ]) {
        expect((store as object) && mutator in (store as object)).toBe(false);
        expect(store[mutator]).toBeUndefined();
      }
      // No constructor/prototype escape to the concrete class.
      expect("constructor" in store).toBe(false);
      expect((store as { constructor?: unknown }).constructor).toBeUndefined();
      // Copies out: mutating the view cannot mutate the live store.
      const ids = store["ids"] as unknown[];
      expect(Object.isFrozen(ids)).toBe(true);
      expect(() => {
        (ids as string[]).push("evil");
      }).toThrow();
      expect(inbox.store.ids).not.toContain("evil");
      const row = inbox.store.thread(THREAD);
      expect(Object.isFrozen(row)).toBe(true);
      const before = inbox.store.thread(THREAD)?.title;
      try {
        (row as unknown as Record<string, unknown>)["title"] = "evil";
      } catch {
        /* Frozen: assignment throws in strict mode. */
      }
      expect(inbox.store.thread(THREAD)?.title).toBe(before);
      // Selections are reader-only values too.
      const sel = inbox.store.select(["ids"], (sidebar) => sidebar.ids);
      expect(Object.getPrototypeOf(sel as object)).toBeNull();
      expect(Object.keys(sel as object).toSorted()).toEqual(["getSnapshot", "subscribe"]);
    } finally {
      inbox.release();
    }

    const one = reads.thread(THREAD);
    try {
      await until(() => one.store.thread !== undefined);
      const tstore = one.store as unknown as Record<string, unknown>;
      expect(Object.getPrototypeOf(tstore)).toBeNull();
      expect(Object.isFrozen(tstore)).toBe(true);
      for (const mutator of [
        "snapshot",
        "delivery",
        "page",
        "restore",
        "fail",
        "recover",
        "setSyncing",
        "setUnconfirmed",
        "export",
        "retainedBytes",
        "configure",
        "acquire",
        "receive",
      ]) {
        expect(mutator in (tstore as object)).toBe(false);
        expect(tstore[mutator]).toBeUndefined();
      }
      expect("constructor" in tstore).toBe(false);
      const order = one.store.order;
      expect(Object.isFrozen(order)).toBe(true);
    } finally {
      one.release();
    }

    // Cached rows are frozen snapshots, never the live store.
    const cached = reads.cachedThreads();
    expect(cached).toBeDefined();
    expect(Object.getPrototypeOf(cached as object)).toBeNull();
    expect(Object.isFrozen(cached)).toBe(true);
    expect((cached as unknown as Record<string, unknown>)["configure"]).toBeUndefined();
    const snapshotIds = [...(cached?.ids ?? [])];
    (snapshotIds as string[]).push("evil");
    expect(reads.cachedThreads()?.ids).not.toContain("evil");
  } finally {
    await produced.disconnectAll();
  }
});

it("a retained lease invalidates its store and selections after disconnect and replacement", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const held = reads.threads();
    try {
      await until(() => held.store.ids.includes(THREAD));
      const retainedStore = held.store;
      const retainedIds = retainedStore.select(["ids"], (sidebar) => sidebar.ids);
      const retainedConn = reads.connectionState();
      const retainedIntent = reads.intent("anything");
      expect(retainedIds.getSnapshot()).toContain(THREAD);

      await produced.disconnectAll();
      // The retained lease no longer reads the stale sidebar: every entry throws.
      expect(() => retainedStore.ids).toThrow("not connected");
      expect(() => retainedStore.thread(THREAD)).toThrow("not connected");
      expect(() => retainedStore.select(["ids"], (sidebar) => sidebar.ids)).toThrow(
        "not connected",
      );
      expect(() => retainedStore.observe(() => {})).toThrow("not connected");
      expect(() => retainedIds.getSnapshot()).toThrow("not connected");
      expect(() => retainedIds.subscribe(() => {})).toThrow("not connected");
      expect(() => retainedConn.getSnapshot()).toThrow("not connected");
      expect(() => retainedIntent.getSnapshot()).toThrow("not connected");
      // Explicit release still detaches the inner subscription without throwing.
      held.release();
      held.release();
      expect(() => held.store.ids).toThrow("not connected");
    } finally {
      held.release();
    }
  } finally {
    await produced.disconnectAll();
  }

  const daemon2 = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced2 = await pairLive(daemon2);
  try {
    const reads = produced2.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const held = reads.thread(THREAD);
    let opened = false;
    try {
      await until(() => held.store.thread !== undefined);
      opened = true;
      const retainedStore = held.store;
      const live = produced2.manager.entry("host-1");
      const url = live?.target.kind === "direct" ? live.target.url : "";
      const { MachineEntry } = await import("@ace/client/machines");
      await produced2.manager.connectEntry(
        MachineEntry.parse({
          hostId: "host-1",
          displayName: "host-1",
          target: { kind: "direct", url, fingerprint: "8e".repeat(32) },
          deviceId: "device-1",
        }),
      );
      expect(opened).toBe(true);
      expect(() => retainedStore.thread).toThrow("not connected");
      expect(() => retainedStore.order).toThrow("not connected");
      expect(() => retainedStore.item("anything")).toThrow("not connected");
      held.release();
      expect(() => held.store.thread).toThrow("not connected");
    } finally {
      held.release();
    }
  } finally {
    await produced2.disconnectAll();
  }
});

it("view-only reads stay usable with no mutation wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const database = memoryDatabase();
  const produced = createProductionStartup({
    bridge: daemonBridge(),
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
  expect(await produced.load()).toEqual([]);
  daemon.createThread({ id: THREAD, workspaceId: "ace", title: "T", provider: "codex" });
  await produced.pair(preparePairing(LINK), "My phone");
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const operateGate = produced.runtimeForMutation("host-1");
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    const before = sent.length;
    {
      const lease = reads.threads();
      try {
        await until(() => lease.store.ids.includes(THREAD));
        expect(lease.store.thread(THREAD)?.title).toBe("T");
      } finally {
        lease.release();
      }
    }
    {
      const lease = reads.thread(THREAD);
      try {
        await until(() => lease.store.thread !== undefined);
      } finally {
        lease.release();
      }
    }
    expect(reads.cachedThreads()?.ids).toContain(THREAD);
    // No command admission or fetch escapes through view-only reads.
    expect(sent.slice(before).some((text) => text.includes("thread.archive"))).toBe(false);
    expect(sent.slice(before).some((text) => text.includes('"command"'))).toBe(false);
    await expect(operateGate.enqueue(archive)).rejects.toBeInstanceOf(ViewOnlyError);
    expect(() => produced.runtimeForMutation("host-1")).toThrow(ViewOnlyError);
  } finally {
    await produced.disconnectAll();
  }
});

it("intent snapshots are isolated copies; mutating them cannot touch the outbox", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    daemon.createThread({ id: THREAD2, workspaceId: "ace", title: "T2", provider: "codex" });
    const archive2 = { type: "thread.archive", threadId: ThreadId.parse(THREAD2) } as const;
    const gate = produced.runtimeForMutation("host-1");
    const id = await gate.enqueue(archive2);
    await until(() => reads.intent(id).getSnapshot()?.state === "acked");

    const sel = reads.intent(id);
    const snap = sel.getSnapshot();
    expect(snap?.state).toBe("acked");
    expect(Object.isFrozen(snap)).toBe(true);
    try {
      (snap as unknown as Record<string, unknown>)["state"] = "pending";
    } catch {
      /* Frozen: assignment throws in strict mode. */
    }
    try {
      ((snap as unknown as Record<string, unknown>)["command"] as Record<string, unknown>)[
        "payload"
      ] = { type: "evil" };
    } catch {
      /* Nested frozen: mutation cannot reach the live record. */
    }
    expect(sel.getSnapshot()?.state).toBe("acked");
    expect(gate.intent(id).getSnapshot()?.state).toBe("acked");

    const inbox = reads.threads();
    try {
      await until(() => inbox.store.ids.includes(THREAD));
      const row = inbox.store.thread(THREAD);
      expect(Object.isFrozen(row)).toBe(true);
      const before = row?.title;
      try {
        (row as unknown as Record<string, unknown>)["title"] = "evil";
      } catch {
        /* Frozen. */
      }
      expect(inbox.store.thread(THREAD)?.title).toBe(before);
    } finally {
      inbox.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("cached snapshots are point-in-time and stay readable after disconnect", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    {
      const lease = reads.threads();
      try {
        await until(() => lease.store.ids.includes(THREAD));
      } finally {
        lease.release();
      }
    }
    const snapBefore = reads.cachedThreads();
    expect(snapBefore?.ids).toContain(THREAD);
    const idsCopy = [...(snapBefore?.ids ?? [])];
    (idsCopy as string[]).push("evil");
    expect(snapBefore?.ids).not.toContain("evil");

    daemon.createThread({ id: THREAD2, workspaceId: "ace", title: "T2", provider: "codex" });
    {
      const lease = reads.threads();
      try {
        await until(() => lease.store.ids.includes(THREAD2));
      } finally {
        lease.release();
      }
    }
    expect(snapBefore?.ids).not.toContain(THREAD2);

    {
      const warm = reads.thread(THREAD);
      try {
        await until(() => warm.store.thread !== undefined);
      } finally {
        warm.release();
      }
    }
    const threadSnap = reads.cachedThread(THREAD);
    expect(threadSnap?.thread?.id).toBe(THREAD);
    expect(Object.isFrozen(threadSnap)).toBe(true);

    const liveLease = reads.thread(THREAD);
    try {
      await until(() => liveLease.store.thread !== undefined);
      const retainedLive = liveLease.store;
      const retainedSnap = threadSnap;
      await produced.disconnectAll();
      expect(() => retainedLive.thread).toThrow("not connected");
      expect(retainedSnap?.thread?.id).toBe(THREAD);
      expect(retainedSnap?.order).toBeDefined();
      expect(
        () => ((retainedSnap as unknown as Record<string, unknown>)["thread"] = null),
      ).toThrow();
      expect(retainedSnap?.thread?.id).toBe(THREAD);
    } finally {
      liveLease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("observe forwards copies and subscriptions detach on release and pin failure", async () => {
  const { projectSidebar, snapshotThread } = await import("./read-projection.ts");
  let innerTap: ((keys: ReadonlySet<string> | "all") => void) | undefined;
  let innerUnsubs = 0;
  const liveSet = new Set<string>(["a"]);
  const fakeLive = {
    error: undefined,
    syncing: false,
    unconfirmed: false,
    loaded: true,
    ids: ["t1"],
    homeWindow: undefined,
    window: undefined,
    thread: () => undefined,
    select: () => {
      throw new Error("unused");
    },
    observe: (tap: (keys: ReadonlySet<string> | "all") => void) => {
      innerTap = tap;
      return () => {
        innerUnsubs += 1;
      };
    },
  };
  let pinFails = false;
  const check = () => {
    if (pinFails) throw new Error("This machine is not connected.");
  };
  const view = projectSidebar(check, fakeLive as never);
  let seen: ReadonlySet<string> | "all" | undefined;
  const stop = view.observe((keys) => {
    seen = keys;
  });
  innerTap?.(liveSet);
  expect(seen).not.toBe(liveSet);
  expect([...(seen as ReadonlySet<string>)]).toEqual(["a"]);
  (seen as Set<string>).add("evil");
  expect(liveSet.has("evil")).toBe(false);
  innerTap?.("all");
  expect(seen).toBe("all");

  pinFails = true;
  const unsubsBefore = innerUnsubs;
  innerTap?.(new Set(["b"]));
  expect(innerUnsubs).toBe(unsubsBefore + 1);
  stop();

  const liveMap = new Map<string, { n: number }>([["k", { n: 1 }]]);
  const liveBytes = new Uint8Array([1, 2, 3]);
  const liveDate = new Date(1_700_000_000_000);
  const fakeThread = {
    error: undefined,
    syncing: false,
    unconfirmed: false,
    thread: { id: THREAD, title: "T", nested: { count: 1 } },
    queue: undefined,
    offshift: undefined,
    context: undefined,
    order: ["i1"],
    cursor: 1,
    itemsBefore: null,
    agentIds: () => ["a1"],
    runIds: undefined,
    interactionIds: () => [],
    taskIds: () => [],
    item: () => ({
      id: "i1",
      extra: { deep: [1, 2] },
      map: liveMap,
      set: liveSet,
      bytes: liveBytes,
      at: liveDate,
    }),
    agent: () => undefined,
    run: () => undefined,
    interaction: () => undefined,
    task: () => undefined,
    usage: () => undefined,
    contextMeter: () => undefined,
    usageSnapshot: () => undefined,
    truncated: () => false,
    select: () => {
      throw new Error("unused");
    },
    observe: () => () => {},
  };
  const snap = snapshotThread(fakeThread as never);
  const item = snap.item("i1") as unknown as {
    extra: { deep: number[] };
    map: Map<string, { n: number }>;
    set: Set<string>;
    bytes: Uint8Array;
    at: Date;
  };
  expect(item.map).not.toBe(liveMap);
  expect(item.set).not.toBe(liveSet);
  expect(item.bytes).not.toBe(liveBytes);
  expect([...item.bytes]).toEqual([1, 2, 3]);
  expect(item.at).not.toBe(liveDate);
  expect(item.at.getTime()).toBe(liveDate.getTime());
  item.bytes[0] = 99;
  expect(liveBytes[0]).toBe(1);
  item.map.set("evil", { n: 2 });
  expect(liveMap.has("evil")).toBe(false);
  item.set.add("evil");
  expect(liveSet.has("evil")).toBe(false);
  const before = (snap.thread as unknown as { title: string }).title;
  try {
    ((item as unknown as Record<string, unknown>)["extra"] as { deep: number[] }).deep.push(3);
  } catch {
    /* Frozen nested array. */
  }
  expect((snap.item("i1") as unknown as { extra: { deep: number[] } }).extra.deep).toEqual([1, 2]);
  expect((snap.thread as unknown as { title: string }).title).toBe(before);
  expect(snap.truncated("i1")).toBe(false);
  expect(snap.appended?.({} as never, {} as never)).toBe(false);
});

it("a released lease detaches its selections; stale connection selections detach", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const produced = await pairLive(daemon);
  try {
    const reads = produced.runtimeForReading("host-1");
    await until(() => reads.connectionState().getSnapshot() === "ready");
    const lease = reads.threads();
    try {
      await until(() => lease.store.ids.includes(THREAD));
      let calls = 0;
      const sel = lease.store.select(["ids"], (sidebar) => sidebar.ids);
      const unsub = sel.subscribe(() => {
        calls += 1;
      });
      lease.release();
      expect(() => sel.getSnapshot()).toThrow("not connected");
      unsub();
      daemon.createThread({ id: THREAD2, workspaceId: "ace", title: "T2", provider: "codex" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toBe(0);
    } finally {
      lease.release();
    }

    const conn = reads.connectionState();
    let connCalls = 0;
    const unsubConn = conn.subscribe(() => {
      connCalls += 1;
    });
    expect(typeof conn.getSnapshot()).toBe("string");
    const callsBeforeDisconnect = connCalls;
    await produced.disconnectAll();
    expect(() => conn.getSnapshot()).toThrow("not connected");
    expect(() => conn.subscribe(() => {})).toThrow("not connected");
    unsubConn();
    const callsAfterDisconnect = connCalls;
    expect(callsAfterDisconnect - callsBeforeDisconnect).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connCalls).toBe(callsAfterDisconnect);
  } finally {
    await produced.disconnectAll();
  }
});
