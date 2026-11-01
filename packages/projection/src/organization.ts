import { threadAttention } from "./thread-attention.ts";
import { snoozeWakeDue, snoozeWakeFor } from "./snooze-wake.ts";
import {
  type Command,
  type Thread,
  type ThreadClientUpdated,
  type EventPayload,
  type SettingsEntry,
  type ThreadDetails,
} from "@ace/protocol";

/** The explicit list is authoritative, including when the last PR was unlinked. */
function pullRequests(details: ThreadDetails | undefined) {
  if (details?.linkedPrs !== undefined) return details.linkedPrs;
  const legacy = details?.linkedPr;
  return legacy ? [legacy] : [];
}

export const organizationCommands = [
  "thread.rename",
  "thread.title.regenerate",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.pin",
  "thread.read",
  "thread.settle",
  "thread.unsettle",
  "thread.autoSettle",
  "thread.snooze",
  "thread.place",
] as const;

/**
 * Organization is independent of execution. Only a running thread refuses settling; a thread
 * waiting on the person can be settled and keeps its request. Deletion requires a quiescent tree.
 */
export function organizationDecision(
  thread: Thread,
  command: Command,
  at: number,
): EventPayload | string {
  const p = command.payload;
  switch (p.type) {
    case "thread.rename":
      return { type: "thread.updated", title: p.title.trim(), titleSource: "person" };
    case "thread.archive":
      return { type: "thread.updated", archivedAt: at };
    case "thread.unarchive":
      return { type: "thread.updated", archivedAt: null };
    case "thread.pin":
      if (!p.pinned)
        return { type: "thread.client.updated", changes: { pinned: false, pinOrder: null } };
      return {
        type: "thread.client.updated",
        changes: {
          pinned: true,
          // Named, or kept when already pinned, else a new pin leads: the clock only grows.
          pinOrder: p.order ?? (thread.pinned ? thread.pinOrder : undefined) ?? at,
        },
      };
    case "thread.place":
      return { type: "thread.client.updated", changes: { listOrder: p.order } };
    case "thread.read":
      return { type: "thread.client.updated", changes: { unread: p.unread, readAt: at } };
    case "thread.settle":
      if (thread.status.state === "working") return "thread_not_done";
      return {
        type: "thread.client.updated",
        changes: {
          settledAt: at,
          settledReason: "manual",
          snoozedUntil: null,
          snoozeWake: null,
          autoSettleAt: null,
        },
      };
    case "thread.unsettle":
      if (p.undo)
        return {
          type: "thread.client.updated",
          changes: { settledAt: null, settledReason: null },
        };
      // The person wants it in the list: the rules that settled it must not settle it again.
      return {
        type: "thread.client.updated",
        changes: {
          settledAt: null,
          settledReason: null,
          activityAt: at,
          autoSettleAt: null,
          autoSettle: false,
          settleWhenDone: null,
        },
      };
    case "thread.autoSettle":
      return {
        type: "thread.client.updated",
        // Turned back on by hand: every rule applies again, a pull request that settled it too.
        changes: p.enabled
          ? { autoSettle: null, prSettled: null, prSettledKey: null }
          : { autoSettle: false, autoSettleAt: null, settleWhenDone: null },
      };
    case "thread.snooze": {
      if (p.until === null)
        return { type: "thread.client.updated", changes: { snoozedUntil: null, snoozeWake: null } };
      if (p.until <= at) return "snooze_in_past";
      const wake = p.wake === undefined ? null : snoozeWakeFor(thread, p.wake);
      if (typeof wake === "string") return wake;
      return {
        type: "thread.client.updated",
        changes: { snoozedUntil: p.until, snoozeWake: wake },
      };
    }
    case "thread.delete":
      if (!["new", "done", "failed"].includes(thread.status.state)) return "thread_busy";
      return { type: "thread.client.updated", changes: { deletedAt: at, autoSettleAt: null } };
    default:
      return "invalid_command";
  }
}
export interface SettlePolicy {
  hours: number;
  merged: boolean;
  closed: boolean;
}
export function settleDecision(
  thread: Thread,
  policy: SettlePolicy,
  at: number,
): ThreadClientUpdated["changes"] {
  const expired = snoozeEnds(thread, at) ? { snoozedUntil: null, snoozeWake: null } : {};
  const request = settleRequest(thread);
  if (request === "settle")
    return {
      ...expired,
      settledAt: at,
      settledReason: "manual",
      autoSettleAt: null,
      settleWhenDone: null,
    };
  const changes = automaticSettle(thread, policy, at, expired);
  return request === "drop" ? { ...changes, settleWhenDone: null } : changes;
}

/**
 * A snooze ends at its time, or on the event it waits for (`snoozeWakeDue`). A wake left behind
 * without its snooze goes too.
 */
function snoozeEnds(thread: Thread, at: number): boolean {
  if (thread.snoozedUntil === undefined) return thread.snoozeWake !== undefined;
  return thread.snoozedUntil <= at || snoozeWakeDue(thread);
}

/**
 * An agent's request to settle its thread once the work ends: kept while the thread works or
 * waits, carried out when it is done, and dropped on any other outcome (failed, limited, a
 * question for the person), which the person should still see.
 */
function settleRequest(thread: Thread): "settle" | "drop" | undefined {
  if (!thread.settleWhenDone) return undefined;
  if (thread.autoSettle === false || threadAttention(thread)) return "drop";
  const state = thread.status.state;
  if (thread.deletedAt === undefined && state === "done") return "settle";
  return state === "working" || state === "waiting" ? undefined : "drop";
}

function automaticSettle(
  thread: Thread,
  policy: SettlePolicy,
  at: number,
  expired: ThreadClientUpdated["changes"],
): ThreadClientUpdated["changes"] {
  // Running work resurfaces a settled thread. A request for the person never auto-settles,
  // but a person may settle it by hand and it stays settled.
  if (thread.deletedAt !== undefined || thread.status.state === "working")
    return { ...expired, autoSettleAt: null, settledAt: null, settledReason: null };
  if (thread.archivedAt !== undefined || thread.pinned || threadAttention(thread))
    return { ...expired, autoSettleAt: null };
  if (thread.settledAt !== undefined || thread.autoSettle === false)
    return { ...expired, autoSettleAt: null };
  // Only a finished tree settles by itself. One still waiting (a background shell, a queued
  // turn, a limit, the person) stays in the list, and settles once it finishes if still due.
  if (!["done", "new", "failed"].includes(thread.status.state))
    return { ...expired, autoSettleAt: null };
  const prs = pullRequests(thread.details);
  // An unresolved or unverified PR blocks every automatic rule, including inactivity.
  if (
    prs.some(
      (pr) =>
        ("unverified" in pr && pr.unverified) ||
        ("deleted" in pr && pr.deleted) ||
        !(pr.state === "merged" || (pr.state === "closed" && policy.closed)),
    )
  )
    return { ...expired, autoSettleAt: null };
  const key = prs.length
    ? JSON.stringify(
        prs
          .map((pr) =>
            "repo" in pr
              ? [pr.repo.forge, pr.repo.host, pr.repo.owner, pr.repo.name, pr.number]
              : [pr.number],
          )
          .map((ref) => JSON.stringify(ref))
          .toSorted(),
      )
    : undefined;
  const alreadySettled =
    key === thread.prSettledKey ||
    (thread.prSettledKey === undefined && prs.length === 1 && prs[0]?.number === thread.prSettled);
  const prRuleEnabled = prs.every((pr) => (pr.state === "merged" ? policy.merged : policy.closed));
  if (key && prRuleEnabled && !alreadySettled)
    return {
      ...expired,
      settledAt: at,
      settledReason: prs.every((pr) => pr.state === "merged") ? "pr_merged" : "pr_closed",
      autoSettleAt: null,
      prSettled: prs[0]?.number,
      prSettledKey: key,
    };
  if (thread.status.state !== "done") return { ...expired, autoSettleAt: null };
  const due =
    policy.hours > 0
      ? (thread.activityAt ?? thread.updatedAt) + policy.hours * 3_600_000
      : undefined;
  return due !== undefined && due <= at
    ? { ...expired, settledAt: at, settledReason: "inactivity", autoSettleAt: null }
    : { ...expired, autoSettleAt: due ?? null };
}

/** Settings resolution belongs to the host; policy interpretation is shared by real and fake hosts. */
export function settlePolicy(entries: readonly SettingsEntry[]): SettlePolicy {
  const policy: SettlePolicy = { hours: 24, merged: true, closed: false };
  for (const entry of entries) {
    if (entry.key === "threads.autoSettleAfter")
      policy.hours =
        entry.value === "1d" ? 24 : entry.value === "2d" ? 48 : entry.value === "1w" ? 168 : 0;
    if (entry.key === "threads.settleOnMerge" && typeof entry.value === "boolean")
      policy.merged = entry.value;
    if (entry.key === "threads.settleOnClose" && typeof entry.value === "boolean")
      policy.closed = entry.value;
  }
  return policy;
}
