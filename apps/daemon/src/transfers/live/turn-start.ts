import type { ThreadStatus } from "@ace/protocol";

/*
 * Whether the moved thread's first turn started on the target (ADR 0191). Pure. Any status but
 * new, failed and a message still queued means the turn ran: it works, waits, needs the person,
 * or already ended. Failed means the one continue message is held unsent by a failure.
 */

export type TurnStart = { kind: "running" } | { kind: "wait" } | { kind: "failed" };

export function turnStart(status: ThreadStatus): TurnStart {
  if (status.state === "failed") return { kind: "failed" };
  // A message still waiting in the queue hasn't reached the agent yet.
  const queued = status.state === "waiting" && status.on === "queue";
  if (status.state === "new" || queued) return { kind: "wait" };
  return { kind: "running" };
}
