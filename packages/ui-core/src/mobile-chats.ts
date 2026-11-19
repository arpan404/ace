import type { ThreadListEntry } from "@ace/protocol";
import { chatDayLabels, chatList, isChatEntry } from "./chat-list.ts";
import type { ChatDay } from "./home-rows.ts";
import { inboxPinnedRank, recentRank, type InboxThread } from "./mobile-inbox.ts";
import { activityOf } from "./thread-state.ts";
import type { ThreadMenuId } from "./thread-menu.ts";
import { threadMatches } from "./thread-match.ts";
import { atWork, needsPerson, standingReader, type Standing } from "./thread-standing.ts";

/*
 * The phone's Chats tab (ADR 0099): the Chats panel's list (`chatList`) as sections a client
 * merges across machines, as it merges the inbox's. Active leads (pinned chats in the person's
 * order, then what needs the person, then what is at work, then the rest), then the settled
 * chats under Today, Yesterday, Previous 7 days and Earlier. Each row carries a rank that
 * depends on that row alone, so sections grouped on separate runtimes merge into the order
 * grouping them together gives. Pure: the caller passes the clock.
 */

export type ChatSectionKey = "active" | ChatDay;

export interface ChatSection {
  key: ChatSectionKey;
  label: string;
  /** Row keys (thread ids) in display order. */
  keys: string[];
  /** Each row's rank, parallel to `keys`. */
  ranks: string[];
  /** The section's place among the others, for merging. */
  order: number;
  /** The rows drawn dimmed: settled chats at rest. */
  settled: boolean;
}

export interface ChatSectionInput {
  now: number;
  /** Activity before this moment counts as seen. */
  baseline: number;
  /** Narrows the chats by title (the Chats search); empty lists them all. */
  query?: string | undefined;
}

const sectionOrder: Record<ChatSectionKey, number> = {
  active: 0,
  today: 1,
  yesterday: 2,
  week: 3,
  earlier: 4,
};

const tail = (thread: InboxThread) => `\u0000${thread.machineId}\u0000${thread.key}`;

const syncing: Standing = { level: "syncing", done: false, held: false };

/** Whether a thread belongs in Chats rather than Threads. */
export function isChatThread(thread: InboxThread): boolean {
  return isChatEntry(thread.entry);
}

/** The chats among `threads`, as the Chats tab lists them. */
export function chatSections(
  threads: readonly InboxThread[],
  input: ChatSectionInput,
): ChatSection[] {
  const text = input.query?.trim() ?? "";
  const byId = new Map<string, InboxThread>();
  const entries: ThreadListEntry[] = [];
  for (const thread of threads) {
    if (text && !threadMatches(thread.entry, text, "Chat")) continue;
    byId.set(thread.entry.id, thread);
    entries.push(thread.entry);
  }
  const read = standingReader({ baseline: input.baseline, now: input.now });
  // A copy the daemon hasn't confirmed reads Syncing, never Done, as the web's list does.
  const standing = (entry: ThreadListEntry) =>
    byId.get(entry.id)?.unconfirmed === true ? syncing : read(entry);
  const list = chatList({ entries, isChat: isChatEntry, standing, now: input.now });
  const pinned = new Set(list.pinned);
  const sections: ChatSection[] = [];
  const active: { key: string; rank: string }[] = [];
  for (const id of list.active) {
    const thread = byId.get(id);
    if (!thread) continue;
    const stands = standing(thread.entry);
    const band = pinned.has(id) ? "0" : needsPerson(stands) ? "1" : atWork(stands) ? "2" : "3";
    const within =
      band === "0" ? inboxPinnedRank(thread) : recentRank(activityOf(thread.entry)) + tail(thread);
    active.push({ key: thread.key, rank: band + within });
  }
  if (active.length) sections.push(section("active", "Active", active, false));
  const days = new Map<ChatDay, { key: string; rank: string }[]>();
  for (const item of list.dated) {
    const thread = byId.get(item.id);
    if (!thread) continue;
    const rows = days.get(item.day) ?? [];
    rows.push({ key: thread.key, rank: recentRank(item.at) + tail(thread) });
    days.set(item.day, rows);
  }
  for (const [day, rows] of days) sections.push(section(day, chatDayLabels[day], rows, true));
  return sections;
}

function section(
  key: ChatSectionKey,
  label: string,
  rows: { key: string; rank: string }[],
  settled: boolean,
): ChatSection {
  return {
    key,
    label,
    keys: rows.map((row) => row.key),
    ranks: rows.map((row) => row.rank),
    order: sectionOrder[key],
    settled,
  };
}

const chatMenuIds: ReadonlySet<ThreadMenuId> = new Set([
  "rename",
  "pin",
  "unpin",
  "move",
  "delete",
]);

/**
 * A chat row's menu, as the web's chat ⋯ offers it: the thread menu's own Rename, Pin or Unpin
 * and Move to project, then Delete, in the thread menu's order.
 */
export function chatMenu(menu: readonly ThreadMenuId[]): ThreadMenuId[] {
  return menu.filter((id) => chatMenuIds.has(id));
}
