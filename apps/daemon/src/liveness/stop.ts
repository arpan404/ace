/*
 * Stop is final (ADR 0052, "Stop and proof of life"). One bounded sequence of attempts for
 * anything ace stops: a local process (interrupt, then SIGTERM, then SIGKILL) or a child on
 * another machine (the cancel, sent again with backoff). After the last attempt's wait the item
 * is stopped whether or not the other side confirmed it. Pure: the caller keeps the progress
 * (durably when it must survive a restart) and passes the time in.
 */

/** One attempt and how long to wait for confirmation before the next. */
export interface StopStep<Action extends string> {
  readonly action: Action;
  readonly waitMs: number;
}
export type StopPlan<Action extends string> = readonly [StopStep<Action>, ...StopStep<Action>[]];

/** How long a local process gets after the provider's own interrupt before SIGTERM. */
export const INTERRUPT_GRACE_MS = 3_000;
/** How long it gets after SIGTERM before SIGKILL. */
export const TERMINATE_GRACE_MS = 3_000;
/** How long after SIGKILL ace waits to see it exit before calling it stopped regardless. */
export const KILL_GRACE_MS = 2_000;

export type ProcessStopAction = "interrupt" | "terminate" | "kill";
/** A local process: the provider's interrupt, then SIGTERM, then SIGKILL. About 8s in all. */
export const PROCESS_STOP: StopPlan<ProcessStopAction> = [
  { action: "interrupt", waitMs: INTERRUPT_GRACE_MS },
  { action: "terminate", waitMs: TERMINATE_GRACE_MS },
  { action: "kill", waitMs: KILL_GRACE_MS },
];
/** A process ace started with no interrupt of its own (a background shell): SIGTERM, SIGKILL. */
export const SIGNAL_STOP: StopPlan<ProcessStopAction> = [
  { action: "terminate", waitMs: TERMINATE_GRACE_MS },
  { action: "kill", waitMs: KILL_GRACE_MS },
];

/** Waits after each cancel sent to another machine: doubling, about 45s in all. */
export const REMOTE_CANCEL_WAITS_MS = [3_000, 6_000, 12_000, 24_000] as const;
/** A child on another machine: the cancel, sent again with backoff while it is unconfirmed. */
export const REMOTE_STOP: StopPlan<"cancel"> = [
  { action: "cancel", waitMs: REMOTE_CANCEL_WAITS_MS[0] },
  ...REMOTE_CANCEL_WAITS_MS.slice(1).map((waitMs) => ({ action: "cancel" as const, waitMs })),
];

/** Where a stop stands: when it began, how many attempts went out and when the last did. */
export interface StopProgress {
  readonly startedAt: number;
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
}

export type StopDecision<Action extends string> =
  /** Make attempt `step` (0-based) now, then record it with `attempted`. */
  | { readonly kind: "attempt"; readonly step: number; readonly action: Action }
  /** Nothing to do until `until`; ask again then. */
  | { readonly kind: "wait"; readonly until: number }
  /** Every attempt went out and none was confirmed in time: it is stopped, unconfirmed. */
  | { readonly kind: "give_up" };

export function startStop(now: number): StopProgress {
  return { startedAt: now, attempts: 0, lastAttemptAt: null };
}

/** The progress after attempt `step` went out at `now`. */
export function attempted(progress: StopProgress, now: number): StopProgress {
  return { ...progress, attempts: progress.attempts + 1, lastAttemptAt: now };
}

/**
 * What to do now. Read again on every tick and after a restart: progress kept from before the
 * restart picks up where it was, and a stop whose last wait has passed gives up at once.
 */
export function nextStop<Action extends string>(
  plan: StopPlan<Action>,
  progress: StopProgress,
  now: number,
): StopDecision<Action> {
  const { attempts, lastAttemptAt, startedAt } = progress;
  // The bound runs from the Stop itself: attempts missed while the daemon was down never
  // stretch it. A clock that went back before the start doesn't end it early.
  if (now >= startedAt + stopBound(plan) && attempts > 0) return { kind: "give_up" };
  if (attempts === 0 || lastAttemptAt === null) return attemptAt(plan, 0);
  const previous = plan[Math.min(attempts, plan.length) - 1];
  const due = lastAttemptAt + (previous?.waitMs ?? 0);
  // A clock that went back never stretches the wait past one step.
  if (now < due && now >= lastAttemptAt) return { kind: "wait", until: due };
  if (attempts >= plan.length) return { kind: "give_up" };
  return attemptAt(plan, attempts);
}

function attemptAt<Action extends string>(
  plan: StopPlan<Action>,
  step: number,
): StopDecision<Action> {
  const entry = plan[step] ?? plan[0];
  return { kind: "attempt", step, action: entry.action };
}

/** The longest a stop under `plan` can take, from its first attempt to giving up. */
export function stopBound<Action extends string>(plan: StopPlan<Action>): number {
  return plan.reduce((sum, step) => sum + step.waitMs, 0);
}
