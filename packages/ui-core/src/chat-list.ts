import type { ThreadListEntry } from "@ace/protocol";
import { isDraft, isRemoved, pinOrderOf } from "./arrange.ts";
import type { ChatDay, HomeRow } from "./home-rows.ts";
import { atWork, type Standing } from "./home-tree.ts";
import { activityOf, isSettled } from "./thread-state.ts";

/*
 * The Chats panel (ADR 0099, ADR 0107): every chat in one flat list, pinned ones first, the rest
 * grouped by the day they last moved. A settled chat stays in its day, dimmed; one whose agent
 * tree still works or asks is never dimmed. Pure: the caller passes the clock.
 */

/** Whether a list entry is a chat by its own details: its project is a hidden chat project. */
export function isChatEntry(entry: Pick<ThreadListEntry, "workspaceId" | "details">): boolean {
  const workspace = entry.details?.workspace;
  // A move not yet confirmed changes the project first: the old details no longer speak for it.
  return workspace?.kind === "chat" && workspace.id === entry.workspaceId;
}

export const chatDayLabels: Readonly<Record<ChatDay, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  earlier: "Earlier",
};

/** The local midnight that starts the day `days` before the one `now` falls in. */
function dayStart(now: number, days: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/** Which day group activity at `at` falls in, by this device's calendar days. */
export function chatDayOf(at: number, now: number): ChatDay {
  if (at >= dayStart(now, 0)) return "today";
  if (at >= dayStart(now, 1)) return "yesterday";
  return at >= dayStart(now, 7) ? "week" : "earlier";
}

export interface ChatList {
  /** Pinned chats in the person's own order. */
  pinned: string[];
  /** Every other chat with its last activity and day, newest first. */
  dated: { id: string; at: number; day: ChatDay }[];
  /** Settled chats at rest: drawn dimmed. */
  settled: string[];
  /** Chats whose status is needs-you, which rise while the list otherwise holds still. */
  needsYou: string[];
}

export interface ChatListInput {
  entries: readonly ThreadListEntry[];
  /** Whether an entry is a chat (`isChatEntry`, or the project list's word). */
  isChat(entry: ThreadListEntry): boolean;
  standing(entry: ThreadListEntry): Standing;
  now: number;
}

const byId = (a: ThreadListEntry, b: ThreadListEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The chats among `entries`, as the Chats panel lists them. */
export function chatList(input: ChatListInput): ChatList {
  const pinned: ThreadListEntry[] = [];
  const rest: ThreadListEntry[] = [];
  const settled: string[] = [];
  const needsYou: string[] = [];
  for (const entry of input.entries) {
    if (isRemoved(entry) || isDraft(entry) || !input.isChat(entry)) continue;
    (entry.pinned === true ? pinned : rest).push(entry);
    const stands = input.standing(entry);
    if (entry.status.state === "needs_you") needsYou.push(entry.id);
    // Settled yet its tree still works or asks: it reads as open work, never dimmed.
    if (isSettled(entry) && !atWork(stands) && stands.level !== "needs-you") settled.push(entry.id);
  }
  pinned.sort(
    (a, b) => pinOrderOf(b) - pinOrderOf(a) || activityOf(b) - activityOf(a) || byId(a, b),
  );
  rest.sort((a, b) => activityOf(b) - activityOf(a) || byId(a, b));
  return {
    pinned: pinned.map((entry) => entry.id),
    dated: rest.map((entry) => {
      const at = activityOf(entry);
      return { id: entry.id, at, day: chatDayOf(at, input.now) };
    }),
    settled,
    needsYou,
  };
}

/**
 * The list with older chats a search found that it hasn't loaded, each in its day by `at` (the
 * matching message's time) and drawn as settled. One the list already holds keeps its place.
 */
export function withChatHits(
  list: ChatList,
  hits: readonly { id: string; at: number }[],
  now: number,
): ChatList {
  const held = new Set([...list.pinned, ...list.dated.map((item) => item.id)]);
  const added = hits.filter((hit) => !held.has(hit.id));
  if (!added.length) return list;
  const dated = [
    ...list.dated,
    ...added.map((hit) => ({ id: hit.id, at: hit.at, day: chatDayOf(hit.at, now) })),
  ].toSorted((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...list, dated, settled: [...list.settled, ...added.map((hit) => hit.id)] };
}

/** The Chats panel's rows: Pinned, then each day group under its heading. */
export function chatRows(list: ChatList): HomeRow[] {
  const settled = new Set(list.settled);
  const row = (id: string): HomeRow => ({ kind: "chat", id, settled: settled.has(id) });
  const rows: HomeRow[] = [];
  if (list.pinned.length) {
    rows.push({ kind: "pinned-label" });
    for (const id of list.pinned) rows.push(row(id));
  }
  let day: ChatDay | undefined;
  for (const item of list.dated) {
    if (item.day !== day) {
      day = item.day;
      rows.push({ kind: "day-label", day });
    }
    rows.push(row(item.id));
  }
  return rows;
}

/** What a rail place's dot says: something waits on the person, or news not yet seen. */
export type PlaceTone = "needs-you" | "unread";

export interface PlaceSignal {
  tone: PlaceTone | undefined;
  /** How many of the place's threads need the person. */
  needsYou: number;
}

export interface PlaceSignals {
  threads: PlaceSignal;
  chats: PlaceSignal;
}

/**
 * Each rail place's dot from its own threads: Chats from chats, Threads from every other thread.
 * A request asks loudest; failures and finished work not yet opened (the Inbox's other
 * holdings) show the unread dot.
 */
export function placeSignals(input: Omit<ChatListInput, "now">): PlaceSignals {
  const threads: PlaceSignal = { tone: undefined, needsYou: 0 };
  const chats: PlaceSignal = { tone: undefined, needsYou: 0 };
  for (const entry of input.entries) {
    if (isRemoved(entry) || isDraft(entry)) continue;
    const level = input.standing(entry).level;
    const place = input.isChat(entry) ? chats : threads;
    if (level === "needs-you") {
      place.needsYou += 1;
      place.tone = "needs-you";
    } else if ((level === "failed" || level === "done-unread") && place.tone === undefined)
      place.tone = "unread";
  }
  return { threads, chats };
}
