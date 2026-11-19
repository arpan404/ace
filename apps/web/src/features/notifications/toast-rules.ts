import type { AutomationRun, ThreadStatus } from "@ace/protocol";
import { finishedSince } from "@ace/ui-core/automations";
import type { NotificationPrefs } from "./notification-prefs.ts";

export type ToastCause =
  | { kind: "needs_you"; threadId: string }
  | { kind: "failed"; threadId: string }
  | { kind: "automation"; run: AutomationRun };

/**
 * Which thread changes deserve a toast. Only a thread already known in another state that
 * moves into needs-you or failed counts: the first snapshot after connecting, and threads
 * that arrive already waiting, are history, not news. Pure.
 */
export function threadToasts(
  previous: ReadonlyMap<string, ThreadStatus["state"]>,
  next: ReadonlyMap<string, ThreadStatus["state"]>,
  prefs: Pick<NotificationPrefs, "needsYou" | "failures" | "automations">,
  /** The thread on screen, whose changes the person is already watching. */
  viewing: string | undefined,
): ToastCause[] {
  const causes: ToastCause[] = [];
  for (const [threadId, state] of next) {
    const before = previous.get(threadId);
    if (before === undefined || before === state || threadId === viewing) continue;
    if (state === "needs_you" && prefs.needsYou) causes.push({ kind: "needs_you", threadId });
    if (state === "failed" && prefs.failures) causes.push({ kind: "failed", threadId });
  }
  return causes;
}

/** Runs that finished since the app opened and haven't had a toast yet (`finishedSince`). */
export function runToasts(
  runs: readonly AutomationRun[],
  prefs: Pick<NotificationPrefs, "needsYou" | "failures" | "automations">,
  since: number,
  toasted: ReadonlySet<string>,
): ToastCause[] {
  if (!prefs.automations) return [];
  return finishedSince(runs, since, toasted).map((run) => ({ kind: "automation", run }));
}
