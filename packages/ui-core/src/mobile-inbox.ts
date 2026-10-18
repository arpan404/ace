import type { ThreadListEntry } from "@ace/protocol";
import type { PendingSend } from "@ace/client";
import { threadAttention } from "@ace/projection";
import { isDraft, isRemoved } from "./arrange.ts";
import { activityOf, isSnoozed } from "./thread-state.ts";
import {
  mobileStatus,
  syncingStatus,
  type StatusDisplay,
  type StatusToken,
} from "./mobile-status.ts";
import { recoveryAttention } from "./recovery-attention.ts";
import type { Tone } from "./status.ts";

/*
 * The native apps' single inbox (issue #560): one list across every paired machine, grouped by
 * what the person has to do. Pure: callers pass the daemon's list entries, the SDK's pending
 * sends and the time. Rows are addressed by a caller-chosen key and carry their machine, so a
 * merged inbox keeps two machines' threads with the same id apart.
 */

export type InboxGroupKey = "needs-you" | "working" | "syncing" | "unsent" | "done" | "snoozed";

/** Top to bottom. Snoozed sits last: it is out of the way until it wakes. */
const groupOrder: readonly InboxGroupKey[] = [
  "needs-you",
  "working",
  "syncing",
  "unsent",
  "done",
  "snoozed",
];

export const inboxGroupLabels: Record<InboxGroupKey, string> = {
  "needs-you": "Needs you",
  working: "Working",
  syncing: "Syncing",
  unsent: "Unsent",
  done: "Done",
  snoozed: "Snoozed",
};

export interface InboxThread {
  key: string;
  machineId: string;
  entry: ThreadListEntry;
  /** The machine's list is a copy the daemon hasn't confirmed (read back from disk). */
  unconfirmed?: boolean | undefined;
}

export interface InboxUnsent {
  key: string;
  machineId: string;
  send: PendingSend;
}

export interface InboxSection {
  key: InboxGroupKey;
  label: string;
  /** Row keys in display order. */
  keys: string[];
  /** Each row's rank, parallel to `keys` (`inboxRank`, `unsentRank`). */
  ranks: string[];
}

/**
 * Where a thread sits, or undefined when the inbox leaves it out (archived, deleted, a draft
 * nobody sent). Only the daemon's whole-tree status says done: a finished root whose child still
 * works reads Working. A request is never hidden by a snooze, and a failure asks the person to
 * look. An unconfirmed copy claims no state beyond a request, which it keeps exposed.
 */
export function inboxGroup(thread: InboxThread, now: number): InboxGroupKey | undefined {
  const { entry } = thread;
  if (isRemoved(entry) || isDraft(entry)) return undefined;
  const state = entry.status.state;
  if (state === "needs_you" || threadAttention(entry) !== undefined) return "needs-you";
  if (isSnoozed(entry, now)) return "snoozed";
  if (thread.unconfirmed) return "syncing";
  if (state === "failed") return "needs-you";
  if (state === "done") return "done";
  return "working";
}

const toneTokens: Record<Tone, StatusToken> = {
  "needs-you": "needsYou",
  working: "working",
  waiting: "waiting",
  failed: "failed",
  done: "done",
  idle: "neutral",
  background: "neutral",
};

/**
 * The status a row shows: a recovery the person must act on ("Not sent", "Review a message"),
 * else the daemon's status, or Syncing while the copy is unconfirmed.
 */
export function inboxStatus(thread: InboxThread): StatusDisplay {
  const { entry } = thread;
  if (thread.unconfirmed && entry.status.state !== "needs_you") return syncingStatus;
  const recovery = recoveryAttention(entry, undefined);
  if (recovery) return { label: recovery.label, token: toneTokens[recovery.tone] };
  return mobileStatus(entry.status);
}

/** Sends the SDK still holds for delivery; accepted and delivered ones are the daemon's now. */
export function isUnsent(send: PendingSend): boolean {
  return send.state === "saving" || send.state === "sent" || send.state === "failed";
}

/** What an unsent row says. Offline, a held send goes out on reconnect. */
export function unsentStatus(send: PendingSend, online: boolean): StatusDisplay {
  if (send.state === "failed") return { label: "Not sent", token: "needsYou" };
  if (send.state === "saving") return { label: "Saving on this device…", token: "neutral" };
  if (!online) return { label: "Sends on reconnect", token: "neutral" };
  return { label: send.waiting ? "Still waiting for your machine…" : "Sending…", token: "neutral" };
}

/** The text of a held send, for its preview. */
export function unsentText(send: PendingSend): string {
  return send.payload.input
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Fixed-width digits so ranks compare as plain strings; timestamps fit with room to spare. */
const rankTop = 9e15;
const ascending = (value: number) =>
  String(Math.min(rankTop, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0))).padStart(
    16,
    "0",
  );
const descending = (value: number) => ascending(rankTop - value);

/**
 * Where a row sorts within its group, as a string compared by UTF-16 code units (JavaScript's
 * own `<`). Most recent activity leads; Working puts running trees above those waiting or
 * stalled; Snoozed lists what wakes soonest first; ties break by machine, then key. A rank
 * depends only on its own row, so a client that groups each machine on its own runtime merges
 * their sections by rank and gets the order grouping them together would.
 */
export function inboxRank(thread: InboxThread, group: InboxGroupKey): string {
  const tail = `\u0000${thread.machineId}\u0000${thread.key}`;
  const recent = descending(activityOf(thread.entry));
  if (group === "working")
    return (thread.entry.status.state === "working" ? "0" : "1") + recent + tail;
  if (group === "snoozed") return ascending(thread.entry.snoozedUntil ?? 0) + recent + tail;
  return recent + tail;
}

/** Unsent rows: each machine's outbox in its own order, machines apart. */
export function unsentRank(machineId: string, position: number): string {
  return `\u0000${machineId}\u0000${ascending(position)}`;
}

/** Section order, for clients that merge sections grouped on separate runtimes. */
export function inboxGroupRank(key: InboxGroupKey): number {
  return groupOrder.indexOf(key);
}

const byRank = (a: { rank: string }, b: { rank: string }) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

/**
 * The inbox's sections in order, empty ones left out, each row with its rank. Unsent lists each
 * machine's outbox in its own order.
 */
export function inboxSections(
  threads: Iterable<InboxThread>,
  unsent: Iterable<InboxUnsent>,
  now: number,
): InboxSection[] {
  const groups = new Map<InboxGroupKey, { key: string; rank: string }[]>();
  for (const thread of threads) {
    const group = inboxGroup(thread, now);
    if (!group) continue;
    const row = { key: thread.key, rank: inboxRank(thread, group) };
    const list = groups.get(group);
    if (list) list.push(row);
    else groups.set(group, [row]);
  }
  const sections: InboxSection[] = [];
  for (const key of groupOrder) {
    let rows: { key: string; rank: string }[];
    if (key === "unsent") {
      rows = [];
      for (const row of unsent)
        if (isUnsent(row.send))
          rows.push({ key: row.key, rank: unsentRank(row.machineId, rows.length) });
      rows.sort(byRank);
    } else rows = (groups.get(key) ?? []).toSorted(byRank);
    if (rows.length)
      sections.push({
        key,
        label: inboxGroupLabels[key],
        keys: rows.map((row) => row.key),
        ranks: rows.map((row) => row.rank),
      });
  }
  return sections;
}
