import type { Intent } from "@ace/client";
import { Command, ThreadListEntry, type CommandPayload, type ThreadStatus } from "@ace/protocol";
import { snoozePresets } from "@ace/ui-core/mobile";
import { expect, test } from "vitest";
import {
  availableInboxActions,
  canActInbox,
  inboxActionPayload,
  isInboxThreadId,
  runInboxAction,
  undoActionFor,
  watchInboxReceipt,
  type InboxActionPort,
} from "./inbox-actions.ts";

const now = 1_700_000_000_000;

function entry(
  id: string,
  status: ThreadStatus,
  extra: Record<string, unknown> = {},
): ThreadListEntry {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    ...extra,
    id,
    status,
    updatedAt: now,
  });
}

function intentFor(commandId: string, state: Intent["state"], error?: string): Intent {
  const payload = inboxActionPayload("archive", "thread-a", now);
  if (!payload) throw new Error("expected a payload");
  return {
    command: Command.parse({ id: commandId, deviceId: "android-spike-device", payload }),
    state,
    ...(error === undefined ? {} : { error }),
  };
}

function stubPort() {
  const enqueued: CommandPayload[] = [];
  const snapshots = new Map<string, Intent | undefined>();
  const listeners = new Map<string, Set<() => void>>();
  let rejection: unknown;
  let rejects = false;
  let nextId = 0;
  const port: InboxActionPort & {
    enqueued: CommandPayload[];
    failNextEnqueue(error?: unknown): void;
    setIntent(id: string, snapshot: Intent | undefined): void;
    listenerCount(id: string): number;
  } = {
    enqueued,
    failNextEnqueue(error = new Error("disk full")) {
      rejection = error;
      rejects = true;
    },
    setIntent(id, snapshot) {
      snapshots.set(id, snapshot);
      for (const listener of listeners.get(id) ?? []) listener();
    },
    listenerCount(id: string) {
      return listeners.get(id)?.size ?? 0;
    },
    async enqueue(payload: CommandPayload): Promise<string> {
      if (rejects) {
        rejects = false;
        throw rejection;
      }
      enqueued.push(payload);
      return `cmd-${nextId++}`;
    },
    intent(id: string) {
      return {
        getSnapshot: () => snapshots.get(id),
        subscribe: (listener: () => void) => {
          let group = listeners.get(id);
          if (!group) {
            group = new Set();
            listeners.set(id, group);
          }
          group.add(listener);
          return () => {
            group?.delete(listener);
          };
        },
      };
    },
  };
  return port;
}

test("archive targets the row's thread through the durable outbox", async () => {
  const port = stubPort();
  const outcome = await runInboxAction(port, "archive", "thread-a", now, undefined, true);
  expect(outcome).toEqual({ admitted: true, commandId: "cmd-0" });
  expect(port.enqueued).toEqual([{ type: "thread.archive", threadId: "thread-a" }]);
});

test("unarchive, settle and unsettle each name the acted-on thread", async () => {
  const port = stubPort();
  for (const kind of ["unarchive", "settle", "unsettle"] as const) {
    const outcome = await runInboxAction(port, kind, "thread-b", now, undefined, true);
    expect(outcome.admitted).toBe(true);
  }
  expect(port.enqueued.map((payload) => payload.type)).toEqual([
    "thread.unarchive",
    "thread.settle",
    "thread.unsettle",
  ]);
  for (const payload of port.enqueued) {
    expect(payload).toMatchObject({ threadId: "thread-b" });
  }
});

test("snooze resolves the shared preset time; wake clears it", async () => {
  const port = stubPort();
  const presets = snoozePresets(now);
  const hour = presets.find((preset) => preset.id === "hour")?.until;
  expect(hour).toBeDefined();
  await runInboxAction(port, "snooze", "thread-nap", now, "hour", true);
  expect(port.enqueued).toEqual([{ type: "thread.snooze", threadId: "thread-nap", until: hour }]);
  await runInboxAction(port, "wake", "thread-nap", now, undefined, true);
  expect(port.enqueued.at(-1)).toEqual({
    type: "thread.snooze",
    threadId: "thread-nap",
    until: null,
  });
});

test("an unknown snooze preset admits nothing and enqueues nothing", async () => {
  const port = stubPort();
  const outcome = await runInboxAction(port, "snooze", "thread-nap", now, "decade" as never, true);
  expect(outcome).toEqual({ admitted: false, error: "That snooze time is no longer offered." });
  expect(port.enqueued).toEqual([]);
});

test("a view-only phone offers no actions and admits nothing: fail closed", async () => {
  expect(canActInbox(undefined)).toBe(false);
  expect(canActInbox(false)).toBe(false);
  expect(canActInbox(true)).toBe(true);

  const live = entry("fresh", { state: "done" });
  for (const canAct of [undefined, false] as const) {
    const offered = availableInboxActions(live, now, canAct);
    expect(offered).toEqual({
      settle: false,
      unsettle: false,
      snooze: false,
      wake: false,
      archive: false,
    });
  }

  const port = stubPort();
  for (const canAct of [undefined, false] as const) {
    const outcome = await runInboxAction(port, "archive", "thread-a", now, undefined, canAct);
    expect(outcome).toEqual({
      admitted: false,
      error: "This phone can only view this machine.",
    });
  }
  expect(port.enqueued).toEqual([]);
});

test("an unreadable thread id admits nothing and never throws", async () => {
  expect(isInboxThreadId("")).toBe(false);
  expect(isInboxThreadId("thread-a")).toBe(true);
  expect(inboxActionPayload("archive", "", now)).toBeUndefined();

  const port = stubPort();
  const outcome = await runInboxAction(port, "archive", "", now, undefined, true);
  expect(outcome).toEqual({ admitted: false, error: "Could not read that inbox action." });
  expect(port.enqueued).toEqual([]);
});

test("a running tree offers no settle; a settled row offers unsettle instead", () => {
  const running = availableInboxActions(entry("busy", { state: "working", agents: 1 }), now, true);
  expect(running.settle).toBe(false);
  expect(running.unsettle).toBe(false);

  const done = availableInboxActions(entry("fresh", { state: "done" }), now, true);
  expect(done.settle).toBe(true);
  expect(done.unsettle).toBe(false);

  const settled = availableInboxActions(
    entry("put-away", { state: "done" }, { settledAt: now, settledReason: "manual" }),
    now,
    true,
  );
  expect(settled.settle).toBe(false);
  expect(settled.unsettle).toBe(true);
  expect(settled.snooze).toBe(false);
});

test("a snoozed row offers wake while a live one offers snooze", () => {
  const snoozed = availableInboxActions(
    entry("nap", { state: "done" }, { snoozedUntil: now + 3_600_000 }),
    now,
    true,
  );
  expect(snoozed.wake).toBe(true);
  expect(snoozed.snooze).toBe(false);

  const live = availableInboxActions(entry("fresh", { state: "done" }), now, true);
  expect(live.wake).toBe(false);
  expect(live.snooze).toBe(true);
  expect(live.archive).toBe(true);
});

test("only archive and settle offer Undo", () => {
  expect(undoActionFor("archive")).toBe("unarchive");
  expect(undoActionFor("settle")).toBe("unsettle");
  expect(undoActionFor("unarchive")).toBeUndefined();
  expect(undoActionFor("unsettle")).toBeUndefined();
  expect(undoActionFor("snooze")).toBeUndefined();
  expect(undoActionFor("wake")).toBeUndefined();
});

test("a save failure admits nothing and the same action retries cleanly", async () => {
  const port = stubPort();
  port.failNextEnqueue();
  const failed = await runInboxAction(port, "settle", "thread-c", now, undefined, true);
  expect(failed).toEqual({ admitted: false, error: "Could not save the request on this device." });
  expect(port.enqueued).toEqual([]);

  const retried = await runInboxAction(port, "settle", "thread-c", now, undefined, true);
  expect(retried.admitted).toBe(true);
  expect(port.enqueued).toEqual([{ type: "thread.settle", threadId: "thread-c" }]);
});

test("a refused command reports its error for retry; an acknowledged one stays silent", async () => {
  const port = stubPort();
  const refused: (string | undefined)[] = [];
  const stopRefused = watchInboxReceipt(port, "cmd-9", (error) => refused.push(error));
  expect(port.listenerCount("cmd-9")).toBe(1);
  port.setIntent("cmd-9", intentFor("cmd-9", "failed", "forbidden"));
  expect(refused).toEqual(["forbidden"]);
  // Terminal: the listener is gone, so a repeated snapshot never re-fires.
  expect(port.listenerCount("cmd-9")).toBe(0);
  port.setIntent("cmd-9", intentFor("cmd-9", "failed", "forbidden"));
  expect(refused).toEqual(["forbidden"]);
  stopRefused();

  const quiet: unknown[] = [];
  const stopQuiet = watchInboxReceipt(port, "cmd-10", (error) => quiet.push(error));
  port.setIntent("cmd-10", intentFor("cmd-10", "acked"));
  expect(quiet).toEqual([]);
  // Acknowledged commands hold no listener either: no leak while waiting on others.
  expect(port.listenerCount("cmd-10")).toBe(0);
  stopQuiet();
});

test("a receipt already terminal at watch time still settles without leaking", async () => {
  const port = stubPort();
  port.setIntent("cmd-11", intentFor("cmd-11", "acked"));
  const quiet: unknown[] = [];
  const stop = watchInboxReceipt(port, "cmd-11", (error) => quiet.push(error));
  expect(quiet).toEqual([]);
  expect(port.listenerCount("cmd-11")).toBe(0);
  stop();

  port.setIntent("cmd-12", intentFor("cmd-12", "failed", "gone"));
  const refused: (string | undefined)[] = [];
  const stopRefused = watchInboxReceipt(port, "cmd-12", (error) => refused.push(error));
  expect(refused).toEqual(["gone"]);
  expect(port.listenerCount("cmd-12")).toBe(0);
  stopRefused();
});
