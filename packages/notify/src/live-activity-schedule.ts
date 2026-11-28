import type { ThreadStatus } from "@ace/protocol";

export type ActivityRow =
  | "needs-you"
  | "working"
  | "failed"
  | "waiting"
  | "limited"
  | "background"
  | "idle"
  | "finished"
  | "syncing";
export interface ActivityThread {
  row: ActivityRow;
  status: ThreadStatus["state"];
  pendingChild?: boolean;
  queued?: boolean;
  background?: boolean;
}
export interface ActivityCounts {
  needsYou: number;
  working: number;
  failed: number;
  waiting: number;
  limited: number;
  background: number;
  done: number;
}
/**
 * Every time here is on the daemon's elapsed (monotonic) clock, never wall time, so a clock
 * someone sets can neither cut the quiet grace short nor hold a push back. Wall time is used
 * only for what goes on the wire (`activityOrder`, `aps.timestamp`).
 */
export interface ActivitySchedule {
  now: number;
  counts: ActivityCounts;
  settledSince: number | undefined;
  frequentUpdates: boolean;
  quiet: boolean;
  last?: { counts: ActivityCounts; at: number };
  attemptedAt?: number;
  retryAt?: number;
}
export interface ActivityOrder {
  seq: number;
  timestamp: number;
}
export type ActivityPush = {
  v: 1;
  timestamp: number;
  priority: 5 | 10;
  staleAfter: number;
  state: ActivityCounts & { seq: number; at: number; phase: "busy" | "settled" };
} & ({ event: "update" } | { event: "end"; dismissAfter: number });

type Decision = { event: "update" | "end"; priority: 5 | 10 } | { at: number };

/** Inbox classification with conservative fallbacks for work a row can present as quiet. */
export function classifyActivityThread({
  row,
  status,
  pendingChild,
  queued,
  background,
}: ActivityThread): ActivityRow {
  if (status === "needs_you" || row === "needs-you") return "needs-you";
  if (status === "working" || row === "working" || pendingChild) return "working";
  if (status === "limited" || row === "limited") return "limited";
  if (status === "unresponsive" || status === "unknown" || queued || row === "syncing")
    return "waiting";
  if (background || row === "background") return "background";
  if (status === "waiting" || row === "waiting") return "waiting";
  return row;
}

export const activityBusy = (counts: ActivityCounts): boolean =>
  counts.needsYou + counts.working + counts.waiting + counts.limited + counts.background > 0;

export const secondOf = (at: number): number => Math.floor(at / 1000);

export const sameActivityCounts = (a: ActivityCounts, b: ActivityCounts): boolean =>
  a.needsYou === b.needsYou &&
  a.working === b.working &&
  a.failed === b.failed &&
  a.waiting === b.waiting &&
  a.limited === b.limited &&
  a.background === b.background &&
  a.done === b.done;

/** The next event, or the first elapsed time at which the current input should be checked again. */
export function activityDecision(input: ActivitySchedule): Decision | undefined {
  const { now, counts, settledSince, last, quiet, attemptedAt = last?.at, retryAt } = input;
  const busy = activityBusy(counts);
  const endAt = busy || settledSince === undefined ? Infinity : settledSince + 120_000;
  // One push per second (`aps.timestamp` has one-second resolution), measured as elapsed time.
  const availableAt = Math.max(retryAt ?? 0, attemptedAt === undefined ? 0 : attemptedAt + 1000);
  if (now >= endAt) {
    return availableAt > now ? { at: availableAt } : { event: "end", priority: quiet ? 5 : 10 };
  }
  const multiplier = input.frequentUpdates ? 1 : 2;
  let updateAt = Infinity;
  let priority: 5 | 10 = 5;
  if (last ? !sameActivityCounts(counts, last.counts) : busy) {
    if (
      last &&
      !quiet &&
      (counts.needsYou > last.counts.needsYou ||
        counts.failed > last.counts.failed ||
        (counts.needsYou === 0 && last.counts.needsYou > 0))
    )
      priority = 10;
    updateAt = !last || priority === 10 ? now : last.at + 30_000 * multiplier;
  } else if (last && busy) {
    updateAt = last.at + 600_000 * multiplier;
  }
  const due = Math.max(updateAt, availableAt);
  if (due <= now) return { event: "update", priority };
  const at = Math.min(due, Math.max(endAt, availableAt));
  return Number.isFinite(at) ? { at } : undefined;
}

/** Reserve before sending so a crash after APNs accepted a push never reuses its order. */
export function activityOrder(last: ActivityOrder, now: number): ActivityOrder {
  const second = secondOf(now);
  return {
    seq: Math.max(last.seq + 1, second),
    timestamp: Math.max(last.timestamp + 1, second),
  };
}
