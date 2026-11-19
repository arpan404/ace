import type { ForgePrStatus } from "@ace/protocol";

/*
 * "Agent fixing this" on the thread or check a Fix with agent request came from. Pure: the
 * web keeps the marks on the device and asks these rules what each shows.
 */

/** A Fix with agent request, tied to what it came from. */
export type FixMark = {
  /** `thread:<review thread id>` or `check:<check id>`, as the attention rows key them. */
  subject: string;
  /** The agent's task the request went to. */
  agentThreadId: string;
  /** The PR's head when it was asked. */
  headSha: string;
  /** When it was asked, ISO 8601. */
  at: string;
};

/** A mark older than this is dropped even if nothing cleared it. */
export const fixMarkTtlMs = 24 * 60 * 60 * 1_000;

/**
 * Whether the fix the mark asked for has landed: for a thread, the agent pushed (the head
 * moved) and someone replied since, or the thread was resolved or is gone; for a check, a push.
 */
export function fixMarkCleared(
  mark: FixMark,
  status: Pick<ForgePrStatus, "headSha" | "reviewThreads">,
): boolean {
  const pushed = status.headSha !== mark.headSha;
  if (mark.subject.startsWith("check:")) return pushed;
  const id = mark.subject.slice("thread:".length);
  const thread = status.reviewThreads.find((t) => t.id === id);
  if (!thread || thread.resolved) return true;
  const asked = Date.parse(mark.at);
  const replied = thread.comments.some((c) => Date.parse(c.createdAt ?? c.updatedAt) > asked);
  return pushed && replied;
}

/** Marks still worth keeping: not cleared, not expired. */
export function liveFixMarks(
  marks: readonly FixMark[],
  status: Pick<ForgePrStatus, "headSha" | "reviewThreads">,
  now: number,
): FixMark[] {
  return marks.filter((m) => now - Date.parse(m.at) < fixMarkTtlMs && !fixMarkCleared(m, status));
}

/**
 * Whether `subject` shows "Agent fixing this": a live mark for it whose agent is busy now.
 * An agent that stopped without a push says nothing rather than claiming work it isn't doing.
 */
export function fixingNow(
  subject: string,
  marks: readonly FixMark[],
  status: Pick<ForgePrStatus, "headSha" | "reviewThreads">,
  busy: (agentThreadId: string) => boolean,
  now: number,
): boolean {
  return liveFixMarks(marks, status, now).some(
    (m) => m.subject === subject && busy(m.agentThreadId),
  );
}
