import type { ThreadStatus } from "@ace/protocol";

/*
 * Whether the moved thread's first turn started on the target (ADR 0190). Pure. Any status but
 * new and failed means the turn ran: it works, waits, needs the person, or already ended.
 */

export type TurnStart =
  | { kind: "running" }
  | { kind: "wait" }
  /** A resumed native session that failed to open: try once more with the handoff summary. */
  | { kind: "retry_with_summary" }
  /** It didn't start; the thread shows the failure there, where the person can act on it. */
  | { kind: "failed" };

/** How long a turn may take to show it started before it counts as not starting. */
export const turnStartMs = 120_000;

export function turnStart(
  status: ThreadStatus,
  attempt: { native: boolean; waitedMs: number },
): TurnStart {
  if (status.state !== "new" && status.state !== "failed") return { kind: "running" };
  const stuck = status.state === "failed" || attempt.waitedMs >= turnStartMs;
  if (!stuck) return { kind: "wait" };
  return attempt.native ? { kind: "retry_with_summary" } : { kind: "failed" };
}
