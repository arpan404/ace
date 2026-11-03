import type { LinkedPullRequest, SnoozedPullRequest, SnoozeWoke, Thread } from "@ace/protocol";
import { snoozedPullRequests, snoozeWakeDue, type WakeFacts } from "./snooze-wake.ts";
import { threadAttention } from "./thread-attention.ts";

/*
 * Why a snooze ended by itself, recorded as it ends so the list can say "Back · checks failed"
 * and the thread can mark where it woke. Pure: the organizer and the queue wake call it with
 * the thread as it stands at the wake.
 */

type PrChange = Extract<SnoozeWoke, { on: "pr" }>["change"];

/** What the thread's tree came to when "until it needs you" ended. */
function needsYouOutcome(
  thread: Pick<Thread, "status" | "queue">,
): Extract<SnoozeWoke, { on: "needs_you" }>["outcome"] {
  const state = thread.status.state;
  if (state === "needs_you" || threadAttention(thread) !== undefined) return "asking";
  if (state === "failed" || state === "unresponsive") return "failed";
  if (state === "limited") return "limited";
  return "finished";
}

/** The most telling change on one pull request since the snooze, if any. */
function prChange(
  before: SnoozedPullRequest,
  now: SnoozedPullRequest | undefined,
): PrChange | undefined {
  if (now === undefined) return "unlinked";
  if (now.state !== before.state) {
    if (now.state === "merged" || now.state === "closed") return now.state;
    if (before.state === "closed") return "reopened";
  }
  if (before.checks === "pending" && now.checks === "failed") return "checks_failed";
  if (before.checks === "pending" && now.checks === "passed") return "checks_passed";
  if (before.head !== undefined && now.head !== undefined && now.head !== before.head)
    return "pushed";
  if (now.updatedAt > before.updatedAt || now.state !== before.state) return "activity";
  return undefined;
}

/** A repository-qualified PR key's number: the last element of its key. */
function keyNumber(key: string, linked: readonly LinkedPullRequest[]): number | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    const number = Array.isArray(parts) ? parts.at(-1) : undefined;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) return number;
  } catch {
    // A key written by another version: fall back to the only linked PR.
  }
  return linked.length === 1 ? linked[0]?.number : undefined;
}

/**
 * Why the snooze on `thread` ends at `at`: the event it waited for when that happened, else its
 * time. Undefined when there is no snooze to end.
 */
export function snoozeWokeFor(
  thread: WakeFacts & Pick<Thread, "snoozedUntil">,
  at: number,
): SnoozeWoke | undefined {
  if (thread.snoozedUntil === undefined) return undefined;
  const wake = thread.snoozeWake;
  if (wake && snoozeWakeDue(thread)) {
    if (wake.on === "needs_you") return { on: "needs_you", at, outcome: needsYouOutcome(thread) };
    const linked = thread.details?.linkedPrs ?? [];
    const now = new Map(snoozedPullRequests(thread.details).map((pr) => [pr.pr, pr]));
    for (const before of wake.prs) {
      const change = prChange(before, now.get(before.pr));
      const number = change && keyNumber(before.pr, linked);
      if (change && number !== undefined) return { on: "pr", at, number, change };
    }
  }
  // A missed time (the daemon was down) still woke at its time.
  return { on: "time", at: Math.min(at, thread.snoozedUntil) };
}

/** A queue that newly needs the person woke the snooze: it is asking. */
export function snoozeWokeByQueue(at: number): SnoozeWoke {
  return { on: "needs_you", at, outcome: "asking" };
}
