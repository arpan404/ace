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
  "thread.snooze",
] as const;

/** Organization is independent of execution. Destructive hiding requires a quiescent tree. */
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
    case "thread.read":
      return { type: "thread.client.updated", changes: { unread: p.unread, readAt: at } };
    case "thread.settle":
      if (thread.status.state !== "done" || threadAttention(thread)) return "thread_not_done";
      return {
        type: "thread.client.updated",
        changes: { settledAt: at, settledReason: "manual", snoozedUntil: null, autoSettleAt: null },
      };
    case "thread.unsettle":
      return {
        type: "thread.client.updated",
        changes: { settledAt: null, settledReason: null, activityAt: at, autoSettleAt: null },
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
  if (thread.deletedAt !== undefined || thread.status.state !== "done" || threadAttention(thread))
    return { ...expired, autoSettleAt: null, settledAt: null, settledReason: null };
  if (thread.archivedAt !== undefined || thread.pinned) return { ...expired, autoSettleAt: null };
  if (thread.settledAt !== undefined) return { ...expired, autoSettleAt: null };
  const due =
    policy.hours > 0
      ? (thread.activityAt ?? thread.updatedAt) + policy.hours * 3_600_000
      : undefined;
  const reason =
    thread.details?.linkedPr?.state === "merged" && policy.merged
      ? "pr_merged"
      : thread.details?.linkedPr?.state === "closed" && policy.closed
        ? "pr_closed"
        : due !== undefined && due <= at
          ? "inactivity"
          : undefined;
  return reason
    ? { ...expired, settledAt: at, settledReason: reason, autoSettleAt: null }
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
