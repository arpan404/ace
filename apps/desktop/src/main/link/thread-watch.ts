import type { ThreadListEntry } from "@ace/protocol";
import { isRemoteChild } from "@ace/ui-core";
import type { Alert } from "../notifications/router.ts";

export interface WorkSummary {
  /** Threads waiting on a person (approvals, questions, plan or merge gates). */
  needsYou: number;
  /** Threads with an agent working or waiting on something other than a person. */
  working: number;
  /**
   * Threads not done that neither move nor wait on the person right now: paused at a usage
   * limit (a provider may be retrying until the reset) or with an agent that stopped
   * answering (its process may still be alive). Stopping the daemon would lose either.
   */
  held: number;
  /**
   * Threads an agent on a paired machine delegated here, working on this machine. Their owner
   * is on that machine, so they never show in this machine's badges or tray, but the app must
   * not quit or let the computer sleep under them.
   */
  hostedWorking: number;
  /** Such threads not done but not moving: waiting on their owner, paused or silent. */
  hostedWaiting: number;
}

type Work = keyof WorkSummary;

export const noWork: WorkSummary = {
  needsYou: 0,
  working: 0,
  held: 0,
  hostedWorking: 0,
  hostedWaiting: 0,
};

function workOf(entry: ThreadListEntry): Work | undefined {
  if (entry.archivedAt) return undefined;
  const hosted = isRemoteChild(entry);
  if (entry.status.state === "needs_you") return hosted ? "hostedWaiting" : "needsYou";
  if (entry.status.state === "working" || entry.status.state === "waiting")
    return hosted ? "hostedWorking" : "working";
  if (entry.status.state === "limited" || entry.status.state === "unresponsive")
    return hosted ? "hostedWaiting" : "held";
  return undefined;
}

/**
 * The work summary, kept one thread at a time: a thread list update costs the same with ten
 * threads or ten thousand, and only a change of the counts is news.
 */
export class WorkTally {
  private work = new Map<string, Work>();
  private counts: WorkSummary = noWork;

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
 * never alerts (a restart must not replay old news). A thread a paired machine delegated here
 * alerts its owner there, never this machine's person.
 */
export function derivedAlerts(
  previous: ThreadListEntry | undefined,
  next: ThreadListEntry,
): Alert[] {
  if (!previous || isRemoteChild(next)) return [];
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
