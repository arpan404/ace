import { threadAttention } from "./thread-attention.ts";
import {
  type Command,
  type Thread,
  type ThreadClientUpdated,
  type EventPayload,
  type SettingsEntry,
} from "@ace/protocol";

export const organizationCommands = [
  "thread.rename",
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
        changes: { settledAt: at, settledReason: "manual", snoozedUntil: null, autoSettleAt: null },
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
          ? { autoSettle: null, prSettled: null }
          : { autoSettle: false, autoSettleAt: null },
      };
    case "thread.snooze":
      if (p.until !== null && p.until <= at) return "snooze_in_past";
      return { type: "thread.client.updated", changes: { snoozedUntil: p.until } };
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
  const expired =
    thread.snoozedUntil !== undefined && thread.snoozedUntil <= at ? { snoozedUntil: null } : {};
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
 * An agent's request to settle its thread once the work ends: kept while the thread works or
 * waits, carried out when it is done, and dropped on any other outcome (failed, limited, a
 * question for the person), which the person should still see.
 */
function settleRequest(thread: Thread): "settle" | "drop" | undefined {
  if (!thread.settleWhenDone) return undefined;
  const state = thread.status.state;
  if (thread.deletedAt === undefined && state === "done") return "settle";
  return state === "working" || state === "waiting" ? undefined : "drop";
}

const quiescentStates = new Set<Thread["status"]["state"]>(["done", "failed", "new"]);

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
  if (!quiescentStates.has(thread.status.state)) return { ...expired, autoSettleAt: null };
  const due =
    policy.hours > 0
      ? (thread.activityAt ?? thread.updatedAt) + policy.hours * 3_600_000
      : undefined;
  // A pull request settles its thread once. Reopened after that, the thread stays open until
  // the person settles it, it goes inactive, or another linked pull request merges or closes.
  const pr = thread.details?.linkedPr;
  const prReason =
    !pr || pr.number === thread.prSettled
      ? undefined
      : pr.state === "merged" && policy.merged
        ? "pr_merged"
        : pr.state === "closed" && policy.closed
          ? "pr_closed"
          : undefined;
  if (prReason && pr)
    return {
      ...expired,
      settledAt: at,
      settledReason: prReason,
      autoSettleAt: null,
      prSettled: pr.number,
    };
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
