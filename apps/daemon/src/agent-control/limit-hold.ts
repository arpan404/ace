import type { DelegationRecord, Thread } from "@ace/protocol";

/**
 * A thread whose turn ended on its provider's usage limit, held until the limit resets or
 * someone switches it. `resumesAt`: ace resumes it then by itself. `resetsAt`: when the limit
 * resets, when known.
 */
export interface UsageLimitHold {
  resumesAt?: number;
  resetsAt?: number;
}

/** What the engine knows about a thread that its stored row doesn't say. */
export interface LimitFacts {
  /** A resume of the thread is in flight (the person's Continue): the hold is ending. */
  resuming: boolean;
  /** Its root turn ended on the limit and nothing runs or retries; read only when needed. */
  endedOnLimit(): boolean;
}

/**
 * The thread's usage-limit hold, if it has one. Only a turn that ended on the limit counts: a
 * provider retrying a rate limit inside a running turn is still working, though it reads
 * limited and its queue is held the same way.
 */
export function usageLimitHold(
  thread: Thread,
  record: DelegationRecord | undefined,
  facts: LimitFacts,
): UsageLimitHold | undefined {
  if (thread.status.state !== "limited" || record?.phase === "cancelling" || facts.resuming)
    return undefined;
  const queue = thread.queue;
  if (!queue?.paused || (queue.reason !== "limit" && queue.reason !== "snooze")) return undefined;
  if (!facts.endedOnLimit()) return undefined;
  const resumesAt = queue.reason === "limit" ? (queue.resumeAt ?? undefined) : undefined;
  const resetsAt = thread.status.until ?? queue.resumeAt ?? undefined;
  return {
    ...(resumesAt === undefined ? {} : { resumesAt }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

const iso = (at: number) => new Date(at).toISOString();

/** Short text for a model: when the held thread carries on. */
export function limitStep(hold: UsageLimitHold): string {
  if (hold.resumesAt !== undefined)
    return `usage limit: resumes by itself at ${iso(hold.resumesAt)}`;
  if (hold.resetsAt !== undefined)
    return `usage limit until ${iso(hold.resetsAt)}; then the person must resume or switch it`;
  return "usage limit: held until the person resumes or switches it";
}

/** What a parent is told when its child `role` (`childId`) is held by a usage limit. */
export function limitNoticeText(hold: UsageLimitHold, role: string, childId: string): string {
  const when =
    hold.resumesAt !== undefined
      ? `ace resumes it at ${iso(hold.resumesAt)}, when the limit resets.`
      : hold.resetsAt !== undefined
        ? `The limit resets at ${iso(hold.resetsAt)}; then it waits for the person to resume or switch it.`
        : "It waits for the person to resume or switch it.";
  return (
    `${role} (${childId}) stopped: its provider account hit its usage limit. ${when} ` +
    "Until then it does no work and a wait on it won't settle. To finish sooner, cancel it with " +
    "agent_cancel and delegate the task again on another provider or account (thread_read shows " +
    "what it did), or tell the person."
  );
}
