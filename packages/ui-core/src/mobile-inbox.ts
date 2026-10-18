import type { ThreadListEntry } from "@ace/protocol";
import type { PendingSend } from "@ace/client";
import { threadAttention } from "@ace/projection";
import { isDraft, isRemoved } from "./arrange.ts";
import { activityOf, isSnoozed } from "./thread-state.ts";
import { mobileStatus, syncingStatus, toneToken, type StatusDisplay } from "./mobile-status.ts";
import { recoveryAttention } from "./recovery-attention.ts";

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

/**
 * The status a row shows: a recovery the person must act on ("Not sent", "Review a message"),
 * else the daemon's status, or Syncing while the copy is unconfirmed.
 */
export function inboxStatus(thread: InboxThread): StatusDisplay {
  const { entry } = thread;
  if (thread.unconfirmed && entry.status.state !== "needs_you") return syncingStatus;
  const recovery = recoveryAttention(entry, undefined);
  if (recovery) return { label: recovery.label, token: toneToken(recovery.tone) };
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

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The inbox's sections in order, empty ones left out. Within a group the most recent activity
 * leads; Working puts running trees above those waiting or stalled; Snoozed lists what wakes
 * soonest first. Unsent keeps the outbox's own order. Ties break by key, so the order is stable
 * across machines and reloads.
 */
export function inboxSections(
  threads: Iterable<InboxThread>,
  unsent: Iterable<InboxUnsent>,
  now: number,
): InboxSection[] {
  const groups = new Map<InboxGroupKey, InboxThread[]>();
  for (const thread of threads) {
    const group = inboxGroup(thread, now);
    if (!group) continue;
    const list = groups.get(group);
    if (list) list.push(thread);
    else groups.set(group, [thread]);
  }
  const recency = (a: InboxThread, b: InboxThread) =>
    activityOf(b.entry) - activityOf(a.entry) || byKey(a.key, b.key);
  const running = (thread: InboxThread) => (thread.entry.status.state === "working" ? 0 : 1);
  const sections: InboxSection[] = [];
  for (const key of groupOrder) {
    let keys: string[];
    if (key === "unsent") {
      keys = [];
      for (const row of unsent) if (isUnsent(row.send)) keys.push(row.key);
    } else {
      const list = groups.get(key) ?? [];
      if (key === "working") list.sort((a, b) => running(a) - running(b) || recency(a, b));
      else if (key === "snoozed")
        list.sort(
          (a, b) =>
            (a.entry.snoozedUntil ?? 0) - (b.entry.snoozedUntil ?? 0) ||
            activityOf(b.entry) - activityOf(a.entry) ||
            byKey(a.key, b.key),
        );
      else list.sort(recency);
      keys = list.map((thread) => thread.key);
    }
    if (keys.length) sections.push({ key, label: inboxGroupLabels[key], keys });
  }
  return sections;
}
