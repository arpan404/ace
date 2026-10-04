import type { ThreadListEntry } from "@ace/protocol";
import type { Alert } from "../notifications/router.ts";

export interface WorkSummary {
  /** Threads waiting on a person (approvals, questions, plan or merge gates). */
  needsYou: number;
  /** Threads with an agent working or waiting on something other than a person. */
  working: number;
}

type Work = keyof WorkSummary;

function workOf(entry: ThreadListEntry): Work | undefined {
  if (entry.archivedAt) return undefined;
  if (entry.status.state === "needs_you") return "needsYou";
  if (entry.status.state === "working" || entry.status.state === "waiting") return "working";
  return undefined;
}

/**
 * The work summary, kept one thread at a time: a thread list update costs the same with ten
 * threads or ten thousand, and only a change of the counts is news.
 */
export class WorkTally {
  private work = new Map<string, Work>();
  private counts: WorkSummary = { needsYou: 0, working: 0 };

  /** Record a thread's latest entry (undefined once it is gone); true if the counts moved. */
  set(id: string, entry: ThreadListEntry | undefined): boolean {
    const next = entry && workOf(entry);
    const previous = this.work.get(id);
    if (next === previous) return false;
    const counts = { ...this.counts };
    if (previous) counts[previous]--;
    if (next) {
      counts[next]++;
      this.work.set(id, next);
    } else this.work.delete(id);
    this.counts = counts;
    return true;
  }

  summary(): WorkSummary {
    return this.counts;
  }
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
