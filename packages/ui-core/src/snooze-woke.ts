import type { SnoozeWoke, ThreadListEntry } from "@ace/protocol";
import { activityOf, isSettled, isSnoozed } from "./thread-state.ts";

/*
 * A thread back from a snooze that ended by itself, and the words for why: short for the row
 * ("checks failed", beside the alarm), whole for the thread's own line ("Back from snooze:
 * checks failed on #1477"). Pure: the caller passes the clock.
 */

/**
 * The wake the row still shows: the snooze ended by itself after the person last read the
 * thread, and it is in the Inbox (not snoozed again, not settled). Reading the thread ends it.
 */
export function backFromSnooze(entry: ThreadListEntry, now: number): SnoozeWoke | undefined {
  const woke = entry.snoozeWoke;
  if (!woke || isSnoozed(entry, now) || isSettled(entry)) return undefined;
  return woke.at > (entry.readAt ?? 0) ? woke : undefined;
}

/**
 * The wake the thread's transcript ends with: the last snooze that ended by itself, while
 * nothing has run since (so the transcript's end is where it woke) and the thread is neither
 * snoozed again nor settled. Unlike the row's, it stays after the thread is read.
 */
export function wokeAtEnd(entry: ThreadListEntry, now: number): SnoozeWoke | undefined {
  const woke = entry.snoozeWoke;
  if (!woke || isSnoozed(entry, now) || isSettled(entry)) return undefined;
  return activityOf(entry) <= woke.at ? woke : undefined;
}

/** Why it is back, in a few words for the row: "checks failed", "#1477 merged". */
export function wokeShort(woke: SnoozeWoke): string {
  switch (woke.on) {
    case "time":
      return "snooze ended";
    case "needs_you":
      return {
        finished: "finished",
        failed: "failed",
        asking: "needs you",
        limited: "usage limit",
      }[woke.outcome];
    case "pr":
      return {
        merged: `#${woke.number} merged`,
        closed: `#${woke.number} closed`,
        reopened: `#${woke.number} reopened`,
        checks_passed: "checks passed",
        checks_failed: "checks failed",
        pushed: "new commits",
        activity: "new comment or review",
        unlinked: `#${woke.number} unlinked`,
      }[woke.change];
  }
}

/** Why it is back, as the thread's line and the row's tooltip say it. */
export function wokeSentence(woke: SnoozeWoke): string {
  switch (woke.on) {
    case "time":
      return "Back from snooze: its time came";
    case "needs_you":
      return {
        finished: "Back from snooze: the agent finished",
        failed: "Back from snooze: the agent failed",
        asking: "Back from snooze: the agent needs you",
        limited: "Back from snooze: the agent hit a usage limit",
      }[woke.outcome];
    case "pr": {
      const pr = `#${woke.number}`;
      return {
        merged: `Back from snooze: ${pr} was merged`,
        closed: `Back from snooze: ${pr} was closed`,
        reopened: `Back from snooze: ${pr} was reopened`,
        checks_passed: `Back from snooze: checks passed on ${pr}`,
        checks_failed: `Back from snooze: checks failed on ${pr}`,
        pushed: `Back from snooze: new commits on ${pr}`,
        activity: `Back from snooze: a new comment or review on ${pr}`,
        unlinked: `Back from snooze: ${pr} was unlinked`,
      }[woke.change];
    }
  }
}
