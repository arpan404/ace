import type { ThreadListEntry } from "@ace/protocol";
import type { PendingSend } from "@ace/client";
import { threadAttention } from "@ace/projection";
import { homeListKey, isDraft, isRemoved, pinOrderOf, type HomeSort } from "./arrange.ts";
import { activityOf, isSettled, isSnoozed } from "./thread-state.ts";
import {
  mobileThreadStatus,
  syncingStatus,
  toneToken,
  type StatusDisplay,
} from "./mobile-status.ts";
import { recoveryAttention } from "./recovery-attention.ts";

/*
 * The native apps' single inbox (issue #560): one list across every paired machine, grouped by
 * what the person has to do. Pure: callers pass the daemon's list entries, the SDK's pending
 * sends and the time. Rows are addressed by a caller-chosen key and carry their machine, so a
 * merged inbox keeps two machines' threads with the same id apart.
 */

export type InboxGroupKey =
  | "pinned"
  | "needs-you"
  | "working"
  | "syncing"
  | "unsent"
  | "threads"
  | "done"
  | "snoozed"
  | "settled";

/**
 * Top to bottom. Pinned leads, as on Home: the person put those threads there. Snoozed and
 * Settled sit last: out of the way until a snooze wakes or the person unsettles a thread.
 * Threads holds every live group when the list is sorted by creation or by hand.
 */
const groupOrder: readonly InboxGroupKey[] = [
  "pinned",
  "needs-you",
  "working",
  "syncing",
  "unsent",
  "threads",
  "done",
  "snoozed",
  "settled",
];

export const inboxGroupLabels: Record<InboxGroupKey, string> = {
  pinned: "Pinned",
  "needs-you": "Needs you",
  working: "Working",
  syncing: "Syncing",
  unsent: "Unsent",
  threads: "Threads",
  done: "Done",
  snoozed: "Snoozed",
  settled: "Settled",
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
  /** How many threads the section holds, loaded or not: Settled counts what the daemon pages. */
  total: number;
}

export interface InboxSectionOptions {
  /**
   * Settled threads in all on the daemon (`settledTotal`), loaded or not. Pass it only for the
   * daemon's own copy: an unconfirmed copy reads Syncing, so it has no Settled section to count.
   */
  settledTotal?: number | undefined;
  /**
   * The machine's `threads.sortBy`, as Home reads it. By activity (the default) the live groups
   * stand apart; by creation or by hand they are one Threads list in that order, so a thread
   * stays where it is while its state changes. Snoozed and Settled stay apart either way.
   */
  sortBy?: HomeSort | undefined;
}

/** The groups that sorting by creation or by hand folds into one Threads list. */
const listedGroups: ReadonlySet<InboxGroupKey> = new Set([
  "needs-you",
  "working",
  "syncing",
  "done",
]);

/**
 * Where a thread sits, or undefined when the inbox leaves it out (archived, deleted, a draft
 * nobody sent). Only the daemon's whole-tree status says done: a finished root whose child still
 * works reads Working. A request is never hidden by a snooze, and a failure asks the person to
 * look. An unconfirmed copy claims no state beyond a request, which it keeps exposed. A settled
 * thread (by hand or by itself, as the web's Settled section reads it) leaves Done for Settled;
 * a working tree or a request is never settled away.
 */
export function inboxGroup(thread: InboxThread, now: number): InboxGroupKey | undefined {
  const { entry } = thread;
  if (isRemoved(entry) || isDraft(entry)) return undefined;
  const state = entry.status.state;
  if (state === "needs_you" || threadAttention(entry) !== undefined) return "needs-you";
  if (isSnoozed(entry, now)) return "snoozed";
  if (thread.unconfirmed) return "syncing";
  if (isSettled(entry)) return "settled";
  if (state === "failed") return "needs-you";
  if (state === "done") return "done";
  return "working";
}

/** What a settled row says once its snooze has passed but its machine hasn't woken it yet. */
export const snoozeEndedLabel = "Snooze ended";

/**
 * The snooze's time has passed on this phone's clock. The daemon clears `snoozedUntil` when it
 * wakes a thread; until a machine that was offline reports that, the phone's copy still holds it.
 */
export function snoozeEnded(entry: ThreadListEntry, now: number): boolean {
  return entry.snoozedUntil !== undefined && entry.snoozedUntil <= now;
}

/**
 * The status a row shows: a recovery the person must act on ("Not sent", "Review a message"),
 * else the daemon's status, or Syncing while the copy is unconfirmed. A settled thread whose
 * snooze has run out says so ("Snooze ended") in its done colour; any live state outranks it.
 */
export function inboxStatus(thread: InboxThread, now: number): StatusDisplay {
  const { entry } = thread;
  if (thread.unconfirmed && entry.status.state !== "needs_you") return syncingStatus;
  const recovery = recoveryAttention(entry, undefined);
  if (recovery) return { label: recovery.label, token: toneToken(recovery.tone) };
  const status = mobileThreadStatus(entry);
  if (entry.status.state === "done" && snoozeEnded(entry, now))
    return { label: snoozeEndedLabel, token: status.token };
  if (entry.status.state === "needs_you") {
    const kind = entry.live?.asking?.[0]?.kind;
    if (kind === "question") return { label: "Question", token: status.token };
    if (kind === "approval") return { label: "Approve", token: status.token };
  }
  if (entry.status.state === "working" && entry.live?.waitingOn)
    return { label: `Waiting on ${entry.live.waitingOn}`, token: status.token };
  return status;
}

/**
 * The next time the inbox changes without any new data: the soonest snooze still to run out.
 * Clients regroup then, so a snooze ends on time even while its machine is offline.
 */
export function inboxNextChange(threads: Iterable<InboxThread>, now: number): number | undefined {
  let next: number | undefined;
  for (const { entry } of threads) {
    const until = entry.snoozedUntil;
    if (until === undefined || until <= now || isRemoved(entry)) continue;
    if (next === undefined || until < next) next = until;
  }
  return next;
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

/**
 * Any finite number as 16 hex digits whose string order is the number's order: the IEEE 754
 * bits with the sign flipped for positives and every bit flipped for negatives. Hand-placed
 * threads sit at fractions between their neighbours, so whole-number ranks would tie them.
 */
function ordered(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number.isFinite(value) && value !== 0 ? value : 0);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = high >>> 31 === 1;
  return negative ? hex(~high) + hex(~low) : hex(high ^ 0x80000000) + hex(low);
}
const hex = (word: number) => (word >>> 0).toString(16).padStart(8, "0");

/**
 * Where a row sorts in the Threads list (sorting by creation or by hand), compared as
 * `inboxRank` is: the higher place leads, whatever the thread's state; ties break by machine,
 * then key.
 */
export function inboxListRank(thread: InboxThread, sortBy: Exclude<HomeSort, "activity">): string {
  return (
    ordered(-homeListKey(sortBy)(thread.entry)) + `\u0000${thread.machineId}\u0000${thread.key}`
  );
}

/**
 * Where a row sorts among Pinned, compared as `inboxRank` is: the higher `pinOrder` leads (the
 * daemon's clock on pin, so the newest pin on any machine leads), then the most recent activity,
 * as Home orders them; ties break by machine, then key.
 */
export function inboxPinnedRank(thread: InboxThread): string {
  return (
    ordered(-pinOrderOf(thread.entry)) +
    descending(activityOf(thread.entry)) +
    `\u0000${thread.machineId}\u0000${thread.key}`
  );
}

/** Unsent rows: each machine's outbox in its own order, machines apart. */
export function unsentRank(machineId: string, position: number): string {
  return `\u0000${machineId}\u0000${ascending(position)}`;
}

/**
 * Each group's rank, in `groupOrder`'s order. Fixed, never renumbered: a client merges layouts
 * from runtimes of different versions, and a layout kept from an earlier launch, so a group
 * added later takes a number of its own (Pinned leads at -1) instead of moving the others.
 */
const groupRanks: Record<InboxGroupKey, number> = {
  pinned: -1,
  "needs-you": 0,
  working: 1,
  syncing: 2,
  unsent: 3,
  threads: 4,
  done: 5,
  snoozed: 6,
  settled: 7,
};

/** Section order, for clients that merge sections grouped on separate runtimes. */
export function inboxGroupRank(key: InboxGroupKey): number {
  return groupRanks[key];
}

const byRank = (a: { rank: string }, b: { rank: string }) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

/**
 * The inbox's sections in order, empty ones left out, each row with its rank. Unsent lists each
 * machine's outbox in its own order. Settled counts the daemon's total, as the web's sidebar
 * does, so it shows even while every loaded settled thread sits elsewhere (snoozed).
 */
export function inboxSections(
  threads: Iterable<InboxThread>,
  unsent: Iterable<InboxUnsent>,
  now: number,
  options: InboxSectionOptions = {},
): InboxSection[] {
  const groups = new Map<InboxGroupKey, { key: string; rank: string }[]>();
  const sortBy = options.sortBy ?? "activity";
  for (const thread of threads) {
    let group = inboxGroup(thread, now);
    if (!group) continue;
    let rank: string;
    // A pinned thread stays in Pinned whatever its state, as on Home; its row still says it.
    if (thread.entry.pinned === true) {
      group = "pinned";
      rank = inboxPinnedRank(thread);
    } else if (sortBy !== "activity" && listedGroups.has(group)) {
      group = "threads";
      rank = inboxListRank(thread, sortBy);
    } else rank = inboxRank(thread, group);
    const row = { key: thread.key, rank };
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
    const total =
      key === "settled" ? Math.max(rows.length, options.settledTotal ?? 0) : rows.length;
    if (total)
      sections.push({
        key,
        label: inboxGroupLabels[key],
        keys: rows.map((row) => row.key),
        ranks: rows.map((row) => row.rank),
        total,
      });
  }
  return sections;
}
