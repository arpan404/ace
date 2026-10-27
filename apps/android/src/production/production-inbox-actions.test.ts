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
  clearUiUndoForCommand,
  dismissInboxActionFailed,
  invalidateAllInboxActionUi,
  invalidateInboxActionUiForHost,
  isInboxActionBusy,
  operableScopedInboxActionUi,
  pendingProductionInboxFailuresForTests,
  pruneInboxActionUiToHosts,
  reportProductionInboxFailureForTests,
  resetProductionInboxActionUiForTests,
  scopedInboxActionUi,
  setUiBusy,
  snapshotProductionInboxActionUiForTests,
  takeInboxActionFailed,
  trackedInboxActionReceiptsForTests,
  trackInboxActionReceipt,
  untrackInboxActionReceipt,
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

it("invalidating one host drops only its Undo, failures, busy and receipts", () => {
  const stopped: string[] = [];
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-a",
    label: "Thread archived",
  });
  reportProductionInboxFailureForTests({
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    message: "Studio: This change could not be applied.",
  });
  setUiBusy("host-1:thread-1:archive", true, "host-1", THREAD);
  setUiBusy("host-2:thread-1:settle", true, "host-2", THREAD);
  trackInboxActionReceipt("host-1", "cmd-a", () => {
    stopped.push("cmd-a");
  });
  trackInboxActionReceipt("host-2", "cmd-b", () => {
    stopped.push("cmd-b");
  });

  invalidateInboxActionUiForHost("host-1");

  // host-1 is gone: its Undo clears and promotes the queued live failure.
  expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-2");
  expect(snapshotProductionInboxActionUiForTests().busy["host-1:thread-1:archive"]).toBeUndefined();
  expect(snapshotProductionInboxActionUiForTests().busy["host-2:thread-1:settle"]).toBe(true);
  expect(stopped).toEqual(["cmd-a"]);
  expect(trackedInboxActionReceiptsForTests()).toEqual([{ hostId: "host-2", commandId: "cmd-b" }]);
  // The hidden host stays hidden: single-view scoping never shows host-2 in host-1.
  expect(scopedInboxActionUi(["host-1"]).failed).toBeNull();
  expect(scopedInboxActionUi(["host-2"]).failed?.hostId).toBe("host-2");
});

it("pruning to live hosts keeps offline offers and drops only departed listeners", () => {
  const stopped: string[] = [];
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    commandId: "cmd-live",
    label: "Thread settled",
  });
  trackInboxActionReceipt("host-1", "cmd-live", () => {
    stopped.push("cmd-live");
  });
  trackInboxActionReceipt("host-2", "cmd-gone", () => {
    stopped.push("cmd-gone");
  });
  setUiBusy("host-2:thread-1:archive", true, "host-2", THREAD);

  // host-1 is still paired but offline: pruning to [host-1] keeps everything
  // live and drops only the departed host-2 listener.
  pruneInboxActionUiToHosts(["host-1"]);

  expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-live");
  expect(snapshotProductionInboxActionUiForTests().busy["host-2:thread-1:archive"]).toBeUndefined();
  expect(stopped).toEqual(["cmd-gone"]);
  expect(trackedInboxActionReceiptsForTests()).toEqual([
    { hostId: "host-1", commandId: "cmd-live" },
  ]);
});

it("untracking a terminal receipt forgets it without touching the offer", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-a",
    label: "Thread archived",
  });
  trackInboxActionReceipt("host-1", "cmd-a", () => {});
  untrackInboxActionReceipt("host-1", "cmd-a");
  expect(trackedInboxActionReceiptsForTests()).toEqual([]);
  expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-a");
  invalidateAllInboxActionUi();
  expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
});

it("removal clears that host's actions and the next tap fails closed", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    armProductionInboxUndoForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "archive",
      commandId: "cmd-stale",
      label: "Thread archived",
    });
    reportProductionInboxFailureForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "settle",
      message: "This change could not be applied.",
    });
    setUiBusy("host-1:thread-1:archive", true, "host-1", THREAD);
    let disposed = 0;
    trackInboxActionReceipt("host-1", "cmd-stale", () => {
      disposed += 1;
    });

    await produced.remove("host-1");

    expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
    expect(snapshotProductionInboxActionUiForTests().failed).toBeNull();
    expect(snapshotProductionInboxActionUiForTests().busy).toEqual({});
    expect(disposed).toBe(1);
    expect(trackedInboxActionReceiptsForTests()).toEqual([]);
    // Fail closed on the removed host: nothing reaches the wire.
    const before = sent.length;
    const outcome = await runProductionInboxAction(produced, "host-1", "archive", THREAD, NOW);
    expect(outcome.admitted).toBe(false);
    expect(sent.length).toBe(before);
  } finally {
    await produced.disconnectAll();
  }
});

it("re-pairing the same host starts without stale actions and admits again", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    armProductionInboxUndoForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "archive",
      commandId: "cmd-old",
      label: "Thread archived",
    });
    await produced.remove("host-1");
    expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();

    await produced.pair(preparePairing(LINK), "My phone");
    expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
    const outcome = await runProductionInboxAction(produced, "host-1", "archive", THREAD, NOW);
    expect(outcome.admitted).toBe(true);
    expect(typeof outcome.commandId).toBe("string");
  } finally {
    await produced.disconnectAll();
  }
});

it("disconnect-all clears every host without dropping the admitted command", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    const outcome = await runProductionInboxAction(produced, "host-1", "archive", THREAD, NOW);
    expect(outcome.admitted).toBe(true);
    const commandId = outcome.commandId ?? "";
    expect(commandId).not.toBe("");
    // The admitted command is durable in the outbox; the UI receipt listener
    // is what teardown drops.
    let disposed = 0;
    trackInboxActionReceipt("host-1", commandId, () => {
      disposed += 1;
    });
    armProductionInboxUndoForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "archive",
      commandId,
      label: "Thread archived",
    });

    await produced.disconnectAll();

    expect(disposed).toBe(1);
    expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
    expect(snapshotProductionInboxActionUiForTests().busy).toEqual({});
    expect(trackedInboxActionReceiptsForTests()).toEqual([]);
  } finally {
    await produced.disconnectAll();
  }
});

it("two hosts keep their own Undo offers until each expires or leaves", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-host-1",
    label: "Thread archived",
  });
  armProductionInboxUndoForTests({
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    commandId: "cmd-host-2",
    label: "Thread settled",
  });

  // The second admit no longer destroys the first machine's offer.
  expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-host-1");
  expect(scopedInboxActionUi(["host-2"]).undo?.commandId).toBe("cmd-host-2");

  // Tearing down one machine keeps the other's offer and listeners.
  invalidateInboxActionUiForHost("host-2");
  expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-host-1");
  expect(scopedInboxActionUi(["host-2"]).undo).toBeNull();
  expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-host-1");
});

it("each host's Undo expires on its own timer", () => {
  vi.useFakeTimers();
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-host-1",
    label: "Thread archived",
  });
  vi.advanceTimersByTime(4000);
  armProductionInboxUndoForTests({
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    commandId: "cmd-host-2",
    label: "Thread settled",
  });
  vi.advanceTimersByTime(1000);
  // host-1's 5s elapsed; host-2 still holds 4s.
  expect(scopedInboxActionUi(["host-1"]).undo).toBeNull();
  expect(scopedInboxActionUi(["host-2"]).undo?.commandId).toBe("cmd-host-2");
  vi.advanceTimersByTime(4000);
  expect(snapshotProductionInboxActionUiForTests().undo).toBeNull();
});

it("a revoked grant hides the Undo without destroying it", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-revoked",
    label: "Thread archived",
  });
  reportProductionInboxFailureForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    message: "This change could not be applied.",
  });

  // View-only: the banner shows nothing, but the store keeps everything.
  expect(operableScopedInboxActionUi(["host-1"], () => false).undo).toBeNull();
  expect(operableScopedInboxActionUi(["host-1"], () => false).failed).toBeNull();
  expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-revoked");

  // Re-grant: the same offer resurfaces without a second admit.
  expect(operableScopedInboxActionUi(["host-1"], () => true).undo?.commandId).toBe("cmd-revoked");
});

it("a throwing grant check fails closed without leaking", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-throwing",
    label: "Thread archived",
  });
  expect(
    operableScopedInboxActionUi(["host-1"], () => {
      throw new Error("grants dead");
    }).undo,
  ).toBeNull();
  expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-throwing");
});

it("a revoked grant keeps the stored Undo while admission fails closed", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    armProductionInboxUndoForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "archive",
      commandId: "cmd-live-offer",
      label: "Thread archived",
    });
    await produced.grants.setScopes("device-1", ["read"]);
    const before = sent.length;
    const outcome = await runProductionInboxAction(produced, "host-1", "settle", THREAD, NOW);
    expect(outcome.admitted).toBe(false);
    expect(outcome.error).toMatch(/View only/i);
    expect(sent.length).toBe(before);
    // The unavailable offer is hidden, never destroyed.
    expect(
      operableScopedInboxActionUi(["host-1"], (host) => produced.canOperate(host)).undo,
    ).toBeNull();
    expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-live-offer");
  } finally {
    await produced.disconnectAll();
  }
});

it("re-tracking a receipt disposes the previous listener", () => {
  const stopped: string[] = [];
  trackInboxActionReceipt("host-1", "cmd-reused", () => {
    stopped.push("first");
  });
  trackInboxActionReceipt("host-1", "cmd-reused", () => {
    stopped.push("second");
  });
  expect(stopped).toEqual(["first"]);
  expect(trackedInboxActionReceiptsForTests()).toEqual([
    { hostId: "host-1", commandId: "cmd-reused" },
  ]);

  // The same command id on another machine is a separate subscription.
  trackInboxActionReceipt("host-2", "cmd-reused", () => {
    stopped.push("other-host");
  });
  expect(trackedInboxActionReceiptsForTests()).toHaveLength(2);
  untrackInboxActionReceipt("host-1", "cmd-reused");
  expect(trackedInboxActionReceiptsForTests()).toEqual([
    { hostId: "host-2", commandId: "cmd-reused" },
  ]);
  expect(stopped).toEqual(["first"]);
});

it("host ids with colons survive busy and receipt teardown", () => {
  setUiBusy("a:b:thread-1:archive", true, "a:b", THREAD);
  setUiBusy("a:thread-1:settle", true, "a", THREAD);
  expect(isInboxActionBusy("a:b", THREAD)).toBe(true);
  expect(isInboxActionBusy("a", THREAD)).toBe(true);

  // Tearing down "a" must not touch the distinct host "a:b".
  invalidateInboxActionUiForHost("a");
  expect(isInboxActionBusy("a:b", THREAD)).toBe(true);
  expect(isInboxActionBusy("a", THREAD)).toBe(false);
  expect(snapshotProductionInboxActionUiForTests().busy["a:b:thread-1:archive"]).toBe(true);

  pruneInboxActionUiToHosts(["a:b"]);
  expect(isInboxActionBusy("a:b", THREAD)).toBe(true);
  pruneInboxActionUiToHosts([]);
  expect(isInboxActionBusy("a:b", THREAD)).toBe(false);

  const stopped: string[] = [];
  trackInboxActionReceipt("a:b", "cmd-colon", () => {
    stopped.push("a:b");
  });
  pruneInboxActionUiToHosts(["a"]);
  expect(stopped).toEqual(["a:b"]);
  expect(trackedInboxActionReceiptsForTests()).toEqual([]);
});

it("retry and dismiss act on the visible failure only", () => {
  const first = {
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    message: "host-1 refused.",
  } as const;
  const second = {
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    message: "host-2 refused.",
  } as const;
  reportProductionInboxFailureForTests(first);
  reportProductionInboxFailureForTests(second);
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-1");
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(1);

  // Retrying the queued host-2 failure leaves host-1's visible banner alone.
  expect(takeInboxActionFailed(second)?.hostId).toBe("host-2");
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-1");
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(0);

  // Dismissing a queued failure never touches the visible one.
  reportProductionInboxFailureForTests(second);
  dismissInboxActionFailed(second);
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-1");
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(0);
});

it("a stale retry tap never consumes a different host's banner", () => {
  const stale = {
    hostId: "host-1",
    threadId: THREAD,
    kind: "settle",
    message: "host-1 refused.",
  } as const;
  const live = {
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    message: "host-2 refused.",
  } as const;
  reportProductionInboxFailureForTests(stale);
  reportProductionInboxFailureForTests(live);
  // Host-1 departs: its visible banner is dropped and host-2 promotes.
  pruneInboxActionUiToHosts(["host-2"]);
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-2");

  // The stale host-1 tap is a no-op and leaves host-2's banner intact.
  expect(takeInboxActionFailed(stale)).toBeNull();
  expect(snapshotProductionInboxActionUiForTests().failed?.hostId).toBe("host-2");
  expect(pendingProductionInboxFailuresForTests()).toHaveLength(0);
});

it("clearing one host's Undo by command keeps the other host and ignores stale clears", () => {
  armProductionInboxUndoForTests({
    hostId: "host-1",
    threadId: THREAD,
    kind: "archive",
    commandId: "cmd-host-1",
    label: "Thread archived",
  });
  armProductionInboxUndoForTests({
    hostId: "host-2",
    threadId: THREAD,
    kind: "settle",
    commandId: "cmd-host-2",
    label: "Thread settled",
  });

  // A stale command id never clears the re-armed offer.
  clearUiUndoForCommand("host-1", "cmd-old");
  expect(scopedInboxActionUi(["host-1"]).undo?.commandId).toBe("cmd-host-1");

  clearUiUndoForCommand("host-1", "cmd-host-1");
  expect(scopedInboxActionUi(["host-1"]).undo).toBeNull();
  expect(scopedInboxActionUi(["host-2"]).undo?.commandId).toBe("cmd-host-2");
});

it("offline keeps offers and receipts; only teardown disposes them", async () => {
  const daemon = new TicketDaemon({ clock: Date.now, hostId: "host-1", token: "unused" });
  const sent: string[] = [];
  const produced = await pairLive(daemon, sent);
  try {
    armProductionInboxUndoForTests({
      hostId: "host-1",
      threadId: THREAD,
      kind: "settle",
      commandId: "cmd-offline",
      label: "Thread settled",
    });
    let disposed = 0;
    trackInboxActionReceipt("host-1", "cmd-offline", () => {
      disposed += 1;
    });

    produced.setOnline(false);
    expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-offline");
    expect(trackedInboxActionReceiptsForTests()).toHaveLength(1);
    expect(disposed).toBe(0);

    produced.setOnline(true);
    expect(snapshotProductionInboxActionUiForTests().undo?.commandId).toBe("cmd-offline");
    expect(trackedInboxActionReceiptsForTests()).toHaveLength(1);
    expect(disposed).toBe(0);
  } finally {
    await produced.disconnectAll();
  }
  // Teardown after the offline window disposes the listener it preserved.
  expect(trackedInboxActionReceiptsForTests()).toEqual([]);
});
