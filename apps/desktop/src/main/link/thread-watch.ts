import type { ThreadListEntry } from "@ace/protocol";
import type { Alert } from "../notifications/router.ts";

export interface WorkSummary {
  /** Threads waiting on a person (approvals, questions, plan or merge gates). */
  needsYou: number;
  /** Threads with an agent working or waiting on something other than a person. */
  working: number;
}

export function summarize(entries: Iterable<ThreadListEntry>): WorkSummary {
  let needsYou = 0;
  let working = 0;
  for (const entry of entries) {
    if (entry.archivedAt) continue;
    if (entry.status.state === "needs_you") needsYou++;
    else if (entry.status.state === "working" || entry.status.state === "waiting") working++;
  }
  return { needsYou, working };
}

/**
 * Alerts the daemon does not send itself, derived from status changes it does publish: a
 * thread that starts waiting on a usage limit. `previous` undefined means first sight, which
 * never alerts (a restart must not replay old news).
 */
export function derivedAlerts(
  previous: ThreadListEntry | undefined,
  next: ThreadListEntry,
): Alert[] {
  if (!previous) return [];
  const wasLimited = previous.status.state === "waiting" && previous.status.on === "rate_limit";
  const isLimited = next.status.state === "waiting" && next.status.on === "rate_limit";
  if (!isLimited || wasLimited) return [];
  return [
    {
      category: "limited",
      id: `limited-${next.id}-${next.updatedAt}`,
      threadId: next.id,
      title: next.title,
      body: "Paused at a usage limit; it resumes when the limit resets",
      link: { kind: "thread", threadId: next.id },
    },
  ];
}
