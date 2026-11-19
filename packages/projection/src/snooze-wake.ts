import type {
  LinkedPullRequest,
  SnoozedPullRequest,
  SnoozeWake,
  SnoozeWoke,
  Thread,
} from "@ace/protocol";
import { threadAttention } from "./thread-attention.ts";

/*
 * Snoozes that end on an event (ADR 0107, "Inbox, Snoozed, Settled"). "Until it needs you"
 * holds only while the thread's tree works or waits: a request for the person, a failure, a
 * finish or a queue that needs recovery ends it. "Until the PR changes" ends when a linked pull
 * request gets a review or comment (its `updatedAt` moves), a push (its head moves), its state
 * changes or its checks finish. Pure: the daemon's organizer applies it on every status, queue
 * and details change, and again for every thread at start, so a wake missed across a restart
 * still happens.
 */

/** The facts a wake reads. A thread list entry carries them too. */
export type WakeFacts = Pick<Thread, "status" | "queue" | "details" | "snoozeWake">;

/** The thread works or waits on something other than the person: "until it needs you" holds. */
export function threadLive(thread: Pick<Thread, "status" | "queue">): boolean {
  const state = thread.status.state;
  return (state === "working" || state === "waiting") && threadAttention(thread) === undefined;
}

const prKey = (pr: LinkedPullRequest) =>
  JSON.stringify([pr.repo.forge, pr.repo.host, pr.repo.owner, pr.repo.name, pr.number]);

/** Linked pull requests the forge has confirmed, as a snooze remembers them. */
export function snoozedPullRequests(details: Thread["details"]): SnoozedPullRequest[] {
  return (details?.linkedPrs ?? [])
    .filter((pr) => !pr.unverified && !pr.deleted)
    .map((pr) => {
      const snoozed: SnoozedPullRequest = {
        pr: prKey(pr),
        state: pr.state,
        updatedAt: pr.updatedAt,
      };
      if (pr.head !== undefined) snoozed.head = pr.head;
      if (pr.checks !== undefined) snoozed.checks = pr.checks;
      return snoozed;
    });
}

/** What moved on one pull request since the snooze, as the wake names it. */
export type PrChange = Extract<SnoozeWoke, { on: "pr" }>["change"];

/**
 * What moved on one pull request since the snooze, the most telling first: a merge or close, a
 * reopen, checks finishing, a push, else any other update (a review, comment, title, draft
 * state). Undefined while nothing moved.
 */
export function prChange(
  before: SnoozedPullRequest,
  now: SnoozedPullRequest | undefined,
): PrChange | undefined {
  if (now === undefined) return "unlinked";
  if (now.state !== before.state && (now.state === "merged" || now.state === "closed"))
    return now.state;
  if (now.state !== before.state && before.state === "closed") return "reopened";
  if (before.checks === "pending" && now.checks === "failed") return "checks_failed";
  if (before.checks === "pending" && now.checks === "passed") return "checks_passed";
  if (before.head !== undefined && now.head !== undefined && now.head !== before.head)
    return "pushed";
  if (now.updatedAt > before.updatedAt || now.state !== before.state) return "updated";
  return undefined;
}

/** Whether the event the snooze waits for has happened. False for a snooze to a time. */
export function snoozeWakeDue(thread: WakeFacts): boolean {
  const wake = thread.snoozeWake;
  if (!wake) return false;
  if (wake.on === "needs_you") return !threadLive(thread);
  const now = new Map(snoozedPullRequests(thread.details).map((pr) => [pr.pr, pr]));
  // A PR unlinked since the snooze is a change too; one linked since isn't watched.
  return wake.prs.some((before) => prChange(before, now.get(before.pr)) !== undefined);
}

/**
 * The wake a snooze command asks for, from the thread as it stands, or why it can't: "until it
 * needs you" only while the thread is live, "until the PR changes" only with a confirmed PR.
 */
export function snoozeWakeFor(
  thread: Pick<Thread, "status" | "queue" | "details">,
  wake: SnoozeWake["on"],
): SnoozeWake | "snooze_not_live" | "snooze_no_pr" {
  if (wake === "needs_you") return threadLive(thread) ? { on: "needs_you" } : "snooze_not_live";
  const prs = snoozedPullRequests(thread.details);
  return prs.length ? { on: "pr", prs } : "snooze_no_pr";
}
