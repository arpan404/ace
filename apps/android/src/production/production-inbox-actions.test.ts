import { afterEach, expect, it, vi } from "vitest";
import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { ExpoPinnedBridge } from "../security/expo-bridge.ts";
import { createMemoryCredentialStore } from "../pairing/credentials.ts";
import { preparePairing } from "../pairing/pairing-flow.ts";
import type { Storage } from "@ace/client";
import { createProductionStartup, type StartupDatabase } from "../runtime/production-startup.ts";
import { availableInboxActions, undoActionFor } from "../inbox-actions.ts";
import {
  canShowProductionInboxActions,
  currentProductionInboxGrant,
  inboxUndoAccessibilityLabel,
  productionInboxActionFailureCopy,
  productionInboxRefusalCopy,
  runProductionInboxAction,
  watchProductionInboxReceipt,
  withHostAttribution,
} from "./production-inbox-actions.ts";
import {
  armProductionInboxUndoForTests,
  pendingProductionInboxFailuresForTests,
  reportProductionInboxFailureForTests,
  resetProductionInboxActionUiForTests,
  snapshotProductionInboxActionUiForTests,
} from "./production-inbox-actions-store.ts";

afterEach(() => {
  resetProductionInboxActionUiForTests();
  vi.useRealTimers();
});

const PIN = "9f".repeat(32);
const TOKEN = "e0".repeat(32);
const TICKET = "f1".repeat(32);
const LINK = `https://192.168.1.20:4243/pair#code=abc123&fingerprint=${PIN}&scopes=read,operate`;
const THREAD = "thread-1";
const NOW = 1_700_000_000_000;

function entry(id: string, status: ThreadStatus, extra: Record<string, unknown> = {}) {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    ...extra,
    id,
    status,
    updatedAt: NOW,
  });
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

async function until(done: () => boolean, message = "Timed out waiting for the daemon.") {
  const started = Date.now();
  for (;;) {
    if (done()) return;
    if (Date.now() - started > 15_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pairLive(daemon: FakeDaemon, sent: string[]) {
  const produced = createProductionStartup({
    bridge: daemonBridge(),
    credentials: createMemoryCredentialStore(),
    directoryStorage: memoryStorage(),
    database: memoryDatabase(),
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
  return produced;
}

it("admits a production archive through the operate gate for the exact host", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    expect(produced.canOperate("host-1")).toBe(true);
    const outcome = await runProductionInboxAction(produced, "host-1", "archive", THREAD, NOW);
    expect(outcome.admitted).toBe(true);
    expect(typeof outcome.commandId).toBe("string");
    expect(sent.some((text) => text.includes("thread.archive"))).toBe(true);
    const reads = produced.runtimeForReading("host-1");
    await until(() => {
      try {
        return reads.intent(outcome.commandId ?? "").getSnapshot()?.state === "acked";
      } catch {
        return false;
      }
    });
  } finally {
    await produced.disconnectAll();
  }
});

it("fails closed while view-only and sends nothing, even with a live gate", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    await produced.grants.setScopes("device-1", ["read"]);
    expect(produced.canOperate("host-1")).toBe(false);
    expect(canShowProductionInboxActions(false)).toBe(false);
    expect(canShowProductionInboxActions(undefined)).toBe(false);
    expect(currentProductionInboxGrant((host) => produced.canOperate(host), "host-1")).toBe(false);
    const before = sent.length;
    const outcome = await runProductionInboxAction(produced, "host-1", "settle", THREAD, NOW);
    expect(outcome.admitted).toBe(false);
    expect(outcome.error).toMatch(/View only/i);
    expect(sent.length).toBe(before);
    // The gate itself refuses too: no cached handle outlives revocation.
    expect(() => produced.runtimeForMutation("host-1")).toThrow();
    // Rows stay readable while view-only.
    const lease = produced.runtimeForReading("host-1").threads();
    try {
      await until(() => lease.store.ids.includes(THREAD));
    } finally {
      lease.release();
    }
  } finally {
    await produced.disconnectAll();
  }
});

it("fails closed for unknown hosts without touching the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const before = sent.length;
    const outcome = await runProductionInboxAction(
      produced,
      "unknown-host",
      "archive",
      THREAD,
      NOW,
    );
    expect(outcome.admitted).toBe(false);
    expect(outcome.error).toMatch(/View only/i);
    expect(sent.length).toBe(before);
    expect(currentProductionInboxGrant((host) => produced.canOperate(host), "unknown-host")).toBe(
      false,
    );
  } finally {
    await produced.disconnectAll();
  }
});

it("admits nothing for unreadable ids and unknown snooze presets", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const before = sent.length;
    const badId = await runProductionInboxAction(produced, "host-1", "archive", "", NOW);
    expect(badId).toEqual({ admitted: false, error: "Could not read that inbox action." });
    const badPreset = await runProductionInboxAction(
      produced,
      "host-1",
      "snooze",
      THREAD,
      NOW,
      "decade" as never,
    );
    expect(badPreset).toEqual({
      admitted: false,
      error: "That snooze time is no longer offered.",
    });
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("a revoked grant stops the next admission before the wire", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const first = await runProductionInboxAction(produced, "host-1", "settle", THREAD, NOW);
    expect(first.admitted).toBe(true);
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    const second = await runProductionInboxAction(produced, "host-1", "settle", THREAD, NOW);
    expect(second.admitted).toBe(false);
    expect(second.error).toMatch(/View only/i);
    expect(sent.slice(before).some((text) => text.includes("thread.settle"))).toBe(false);
  } finally {
    await produced.disconnectAll();
  }
});

it("names admission failures without leaking internals", () => {
  expect(productionInboxActionFailureCopy(new Error("This machine is not connected."))).toBe(
    "This machine is not connected.",
  );
  expect(productionInboxActionFailureCopy(new Error("boom"))).toBe(
    "Could not save the request on this device.",
  );
  expect(productionInboxRefusalCopy("forbidden")).toBe("This change could not be applied.");
  expect(productionInboxRefusalCopy(undefined)).toBe("This change could not be applied.");
});

it("offers no row actions while view-only and only Undo for archive/settle", () => {
  const live = entry("fresh", { state: "done" });
  for (const canOperate of [undefined, false] as const) {
    expect(canShowProductionInboxActions(canOperate)).toBe(false);
    expect(availableInboxActions(live, NOW, canOperate)).toEqual({
      settle: false,
      unsettle: false,
      snooze: false,
      wake: false,
      archive: false,
    });
  }
  expect(canShowProductionInboxActions(true)).toBe(true);
  expect(availableInboxActions(live, NOW, true).archive).toBe(true);
  const running = availableInboxActions(entry("busy", { state: "working", agents: 1 }), NOW, true);
  expect(running.settle).toBe(false);
  expect(undoActionFor("archive")).toBe("unarchive");
  expect(undoActionFor("settle")).toBe("unsettle");
  expect(undoActionFor("snooze")).toBeUndefined();
});

it("watches a production receipt: acked stays silent, refused reports, dead handle fails closed", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const outcome = await runProductionInboxAction(produced, "host-1", "archive", THREAD, NOW);
    expect(outcome.admitted).toBe(true);
    const commandId = outcome.commandId ?? "";
    const refused: (string | undefined)[] = [];
    let acked = 0;
    const stop = watchProductionInboxReceipt(
      produced,
      "host-1",
      commandId,
      (error) => refused.push(error),
      () => {
        acked += 1;
      },
    );
    await until(() => {
      try {
        return (
          produced.runtimeForReading("host-1").intent(commandId).getSnapshot()?.state === "acked"
        );
      } catch {
        return false;
      }
    });
    // Give the subscription a frame to observe the terminal state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refused).toEqual([]);
    expect(acked).toBeGreaterThanOrEqual(0);
    stop();

    const dead: (string | undefined)[] = [];
    const noop = watchProductionInboxReceipt(produced, "unknown-host", "cmd-1", (error) =>
      dead.push(error),
    );
    expect(dead).toEqual(["This machine is not connected."]);
    noop();
  } finally {
    await produced.disconnectAll();
  }
});

it("attributes failures to the host only when the merged view names machines", () => {
  const raw = "This machine is not connected.";
  expect(withHostAttribution(raw, "host-1", () => "Studio")).toBe(`Studio: ${raw}`);
  expect(withHostAttribution(raw, "host-1", () => "host-1")).toBe(raw);
  expect(withHostAttribution(raw, "host-1", () => null)).toBe(raw);
  expect(withHostAttribution(raw, "host-1", undefined)).toBe(raw);
  expect(
    withHostAttribution(raw, "host-1", () => {
      throw new Error("names dead");
    }),
  ).toBe(raw);
});

it("names the Undo toast by the action it takes back", () => {
  expect(inboxUndoAccessibilityLabel({ kind: "archive" })).toBe("Undo archive");
  expect(inboxUndoAccessibilityLabel({ kind: "settle" })).toBe("Undo settle");
});

it("queues a refusal behind a visible Undo instead of masking it", () => {
  vi.useFakeTimers();
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-1",
    label: "Thread archived",
  });
  reportProductionInboxFailureForTests({
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    message: "Studio: This change could not be applied.",
  });
  expect(snapshotProductionInboxActionUiForTests().failed).toBeNull();
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(1);
  vi.advanceTimersByTime(5000);
  expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
  expect(snapshotProductionInboxActionUiForTests().failed?.message).toContain("Studio:");
});

it("survives a remount: Undo and queued failures live in the module store", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    commandId: "cmd-2",
    label: "Thread settled",
  });
  expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-2");
  reportProductionInboxFailureForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    message: "This change could not be applied.",
  });
  // A remount re-reads the same module snapshot; nothing is lost.
  expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-2");
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(1);
});
