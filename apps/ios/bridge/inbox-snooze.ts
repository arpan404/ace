import { ThreadId, type CommandPayload } from "@ace/protocol";
import {
  eventSnoozeBackstopMs,
  snoozeBefore,
  snoozedToast,
  snoozeLabel,
  type SnoozeSetting,
} from "@ace/ui-core";
import { snoozePresets } from "@ace/ui-core/mobile";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { InboxOrganizer } from "./inbox-organize.ts";
import type { InboxClock } from "./inbox-rows.ts";
import { preview } from "./presentation.ts";

/*
 * Snoozing a thread from the phone, as the web's Snooze menu does (`use-thread-actions.ts`): a
 * time preset, or until an event the row offers (`snoozeEvents`: it needs you, or its PR
 * changes) with the shared backstop. It shows on the row at once and goes through the SDK's
 * durable outbox; the answer carries the toast's words and what Undo puts back (`snoozeAt`).
 */

export const InboxSnoozeRequest = z.object({
  type: z.literal("inbox.snooze"),
  threadId: ThreadId,
  /** A preset from the layout's `snooze`, or one of the row's `snoozeEvents`. */
  choice: z.enum(["hour", "tomorrow", "monday", "needs_you", "pr"]),
});
export type InboxSnoozeRequest = z.infer<typeof InboxSnoozeRequest>;

export interface SnoozeAnswer {
  /** Saved on this device; the machine's refusal, if any, comes later as the receipt. */
  saved: boolean;
  /** Why it wasn't saved; empty when it was. */
  message: string;
  /** "Snoozed until it needs you · Fix login", beside Undo. */
  toast: string;
  /** The snooze Undo puts back (`snoozeAt`); no `until` wakes the thread. */
  undo: { until: number | null; wake: SnoozeSetting["wake"] | null };
}

const unsaved = "Couldn't save that snooze on this device. Try again.";

function settingOf(choice: InboxSnoozeRequest["choice"], now: number): SnoozeSetting | undefined {
  if (choice === "needs_you" || choice === "pr")
    return { until: now + eventSnoozeBackstopMs, wake: choice };
  const until = snoozePresets(now).find((preset) => preset.id === choice)?.until;
  return until === undefined ? undefined : { until };
}

export async function runSnooze(
  organizer: InboxOrganizer,
  clock: InboxClock,
  request: InboxSnoozeRequest,
  requestId: string,
  pump: PatchSink,
): Promise<SnoozeAnswer> {
  const now = clock.now();
  const entry = organizer.entry(request.threadId);
  const before = snoozeBefore(entry ?? {}, now);
  const undo = { until: before.until, wake: before.wake ?? null };
  const setting = settingOf(request.choice, now);
  if (!setting?.until) return { saved: false, message: unsaved, toast: "", undo };
  const { until, wake } = setting;
  const payload: CommandPayload = {
    type: "thread.snooze",
    threadId: request.threadId,
    until,
    ...(wake ? { wake } : {}),
  };
  const saved = await organizer.run(
    request.threadId,
    { snoozedUntil: until, snoozeWake: wake ?? null },
    payload,
    requestId,
    pump,
  );
  // The words for what it waits for, not the backstop's date.
  const label = snoozeLabel({ snoozedUntil: until, snoozeWake: wake && { on: wake } }, now);
  const toast = snoozedToast(preview(entry?.title ?? "", 512), label);
  return { saved, message: saved ? "" : unsaved, toast, undo };
}

/** What the machine says of a snooze put back that it finds over: its time passed, or its event can't come. */
const over = new Set(["snooze_in_past", "snooze_not_live", "snooze_no_pr"]);

/**
 * Put a snooze back as it was, event and all (Undo of a snooze or of a settle), or wake the
 * thread (`until` null). One the machine finds already over, by its own clock or because its
 * event can no longer come, would have woken by now: the thread is woken instead, so Undo never
 * leaves the snooze it took back in place, and that wake's answer is the receipt. Unless the
 * person changed the thread's snooze again here since: that newer change stands, and the
 * machine's refusal is Undo's receipt, as for any refused action.
 */
export function putSnoozeBack(
  organizer: InboxOrganizer,
  action: { threadId: ThreadId; until: number | null; wake?: SnoozeSetting["wake"] | null },
  requestId: string,
  pump: PatchSink,
): Promise<boolean> {
  const { threadId, until } = action;
  const wake = until === null ? undefined : (action.wake ?? undefined);
  let ended = false;
  const answer: PatchSink = {
    clear: (prefix) => pump.clear(prefix),
    put: (key, read) => {
      if (!(ended && key === `receipt:${requestId}`)) pump.put(key, read);
    },
  };
  let turn = 0;
  const saved = organizer.run(
    threadId,
    { snoozedUntil: until, snoozeWake: wake ?? null },
    { type: "thread.snooze", threadId, until, ...(wake ? { wake } : {}) },
    requestId,
    answer,
    (result) => {
      const newer = organizer.snoozeTurn(threadId) !== turn;
      ended = !result.ok && over.has(result.error ?? "") && !newer;
      if (ended) wakeInstead(organizer, threadId, requestId, pump);
    },
  );
  // `run` has counted this put-back already: any later turn is a newer change.
  turn = organizer.snoozeTurn(threadId);
  return saved;
}

/** The wake that answers for a put-back the machine found over, under the put-back's request. */
function wakeInstead(
  organizer: InboxOrganizer,
  threadId: ThreadId,
  requestId: string,
  pump: PatchSink,
) {
  const wakeId = `${requestId}:wake`;
  const answer: PatchSink = {
    clear: (prefix) => pump.clear(prefix),
    put: (key, read) => {
      if (key !== `receipt:${wakeId}`) return;
      pump.put(`receipt:${requestId}`, () => {
        const value = read();
        return value && { ...value, id: requestId };
      });
    },
  };
  void organizer
    .run(
      threadId,
      { snoozedUntil: null },
      { type: "thread.snooze", threadId, until: null },
      wakeId,
      answer,
    )
    .then((saved) => {
      if (saved) return;
      pump.put(`receipt:${requestId}`, () => ({
        type: "receipt",
        id: requestId,
        ok: false,
        message: "Couldn't save that on this device.",
      }));
    });
}
