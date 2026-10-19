import type { ChangeTap, ClientCore, PendingSend, SidebarSource } from "@ace/client";
import {
  inboxGroupRank,
  inboxNextChange,
  inboxSections,
  inboxStatus,
  snoozePresets,
  unsentStatus,
  unsentText,
  type InboxThread,
} from "@ace/ui-core/mobile";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { z } from "zod";
import { host } from "./host.ts";
import { preview, threadRow } from "./presentation.ts";
import { dispatchCommand } from "./commands.ts";
import type { PatchSink } from "./agents.ts";

/** The phone's clock and timers, injected so a snooze's end is testable without waiting. */
export interface InboxClock {
  now(): number;
  set(delayMs: number, run: () => void): () => void;
}
/** Native timers take 32-bit delays; a longer wait re-arms when it fires. */
const longestWait = 2 ** 31 - 1;

/*
 * The inbox as native rows: each thread's row with its ready-made status, the shared grouping
 * as ordered sections, and the outbox's unsent sends. Swift draws them and maps token keys to
 * colours; it never groups or labels. Rows are keyed by thread id and carry their machine; each
 * section row carries its shared rank, so the app merges every machine's runtime by rank.
 */

function inboxThread(store: SidebarSource, machineId: string, id: string): InboxThread | undefined {
  const entry = store.thread(id);
  return entry && { key: id, machineId, entry, unconfirmed: store.unconfirmed === true };
}

export function followInbox(
  owner: ClientCore,
  machineId: string,
  pump: PatchSink,
  clock: InboxClock,
): () => void {
  const store = owner.threads().store;
  const sends = owner.pendingSends();
  const connection = owner.connectionState();
  const row = (id: string) =>
    pump.put(`inbox:${id}`, () => {
      const thread = inboxThread(store, machineId, id);
      return {
        type: "inbox.row",
        id,
        row: thread
          ? {
              ...threadRow(thread.entry),
              machineId,
              status: inboxStatus(thread, clock.now()),
              activityAt: thread.entry.activityAt ?? thread.entry.updatedAt,
              archivedAt: thread.entry.archivedAt ?? null,
            }
          : null,
      };
    });
  // A snooze runs out on this phone's clock even while its machine is offline (and so can't
  // wake it): at the soonest end, the rows it ends say so and the sections regroup.
  let wake: { at: number; cancel: () => void } | undefined;
  const arm = (at: number | undefined) => {
    if (wake?.at === at) return;
    wake?.cancel();
    wake = undefined;
    if (at === undefined) return;
    const cancel = clock.set(Math.min(longestWait, Math.max(0, at - clock.now())), () => {
      wake = undefined;
      const now = clock.now();
      for (const id of store.ids) {
        const until = store.thread(id)?.snoozedUntil;
        if (until !== undefined && until <= now) row(id);
      }
      sections();
    });
    wake = { at, cancel };
  };
  // Read at delivery, so a burst of changes costs one grouping per frame.
  const sections = () =>
    pump.put("inbox:sections", () => {
      const now = clock.now();
      const threads: InboxThread[] = [];
      for (const id of store.ids) {
        const thread = inboxThread(store, machineId, id);
        if (thread) threads.push(thread);
      }
      arm(inboxNextChange(threads, now));
      const unsent = sends.getSnapshot().map((send) => ({ key: send.commandId, machineId, send }));
      return {
        type: "inbox.sections",
        sections: inboxSections(threads, unsent, now).map((section) => ({
          key: section.key,
          label: section.label,
          ids: section.keys,
          // A merged inbox orders sections from every machine by these (`inboxRank`).
          ranks: section.ranks,
          order: inboxGroupRank(section.key),
        })),
        // The inbox pages home; while the archive is open the store's own window is the archive's.
        more: (store.homeWindow ?? store.window)?.before != null,
        snooze: snoozePresets(now).map((preset) => ({ id: preset.id, label: preset.label })),
      };
    });
  const pending = (id: string) =>
    pump.put(`pending:${id}`, () => {
      const send = owner.pendingSend(id);
      return { type: "pending", id, row: send ? pendingRow(send, connection.getSnapshot()) : null };
    });
  let unconfirmed = store.unconfirmed === true;
  const change: ChangeTap = (keys) => {
    const flipped = unconfirmed !== (store.unconfirmed === true);
    unconfirmed = store.unconfirmed === true;
    if (keys === "all" || keys.has("ids")) {
      pump.clear("inbox:");
      pump.put("inbox:reset", () => ({ type: "inbox.reset" }));
      for (const id of store.ids) row(id);
    } else if (flipped) for (const id of store.ids) row(id);
    else for (const key of keys) if (key.startsWith("thread:")) row(key.slice(7));
    sections();
  };
  const stops = [
    store.observe(change),
    owner.observePendingSends((id) => {
      pending(id);
      sections();
    }),
    // Offline changes what a held send says ("Sends on reconnect").
    connection.subscribe(() => {
      for (const send of sends.getSnapshot()) pending(send.commandId);
    }),
  ];
  change("all");
  return () => {
    for (const stop of stops) stop();
    arm(undefined);
  };
}

function pendingRow(send: PendingSend, connection: string) {
  const status = unsentStatus(send, connection === "ready");
  return {
    id: send.commandId,
    threadId: send.threadId,
    state: send.state,
    waiting: send.waiting,
    text: preview(unsentText(send), 8192),
    label: status.label,
    token: status.token,
  };
}

const InboxAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive"), threadId: ThreadId }),
  z.object({ kind: z.literal("unarchive"), threadId: ThreadId }),
  z.object({
    kind: z.literal("snooze"),
    threadId: ThreadId,
    preset: z.enum(["hour", "tomorrow", "monday"]),
  }),
  z.object({ kind: z.literal("wake"), threadId: ThreadId }),
  z.object({ kind: z.literal("more") }),
]);

function payloadOf(action: z.infer<typeof InboxAction>, now: number): CommandPayload | undefined {
  switch (action.kind) {
    case "archive":
      return { type: "thread.archive", threadId: action.threadId };
    case "unarchive":
      return { type: "thread.unarchive", threadId: action.threadId };
    case "snooze": {
      const until = snoozePresets(now).find((preset) => preset.id === action.preset)?.until;
      return until === undefined
        ? undefined
        : { type: "thread.snooze", threadId: action.threadId, until };
    }
    case "wake":
      return { type: "thread.snooze", threadId: action.threadId, until: null };
    default:
      return undefined;
  }
}

/** Organization goes through the SDK's durable outbox: admission first, the receipt later. */
export function inboxAction(
  owner: ClientCore,
  raw: unknown,
  requestId: string,
  pump: PatchSink,
): void {
  const parsed = InboxAction.safeParse(raw);
  if (!parsed.success) {
    pump.put(`admission:${requestId}`, () => ({
      type: "admission",
      id: requestId,
      ok: false,
      message: "Could not read that inbox action.",
    }));
    return;
  }
  const action = parsed.data;
  if (action.kind === "more") {
    void owner.threadsMore().catch(() =>
      pump.put("error", () => ({
        type: "error",
        message: "Older threads load once your machine is connected.",
      })),
    );
    return;
  }
  void dispatchCommand(owner, payloadOf(action, host.now()), requestId, pump);
}
