import type { ThreadListEntry } from "@ace/protocol";
import { isDraft, isRemoteChild, isRemoved, pinOrderOf } from "./arrange.ts";
import type { ChatDay, HomeRow } from "./home-rows.ts";
import { atRest, atWork, needsPerson, type Standing } from "./thread-standing.ts";
import { activityOf, isSettled } from "./thread-state.ts";

/*
 * The Chats panel (ADR 0099, ADR 0107), as the Threads panel: Active on top, every unsettled chat
 * (pinned ones first, then what needs the person, then what is at work, then the rest by
 * activity), then the settled chats grouped by the day they last moved, dimmed. A settled chat
 * whose agent tree still works or asks is Active, never dimmed. Pure: the caller passes the clock.
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
  /** Every unsettled chat: pinned ones in the person's own order, then by how it stands. */
  active: string[];
  /** The pinned chats that lead Active, in the person's own order. */
  pinned: string[];
  /** Settled chats at rest with their last activity and day, newest first. */
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
const newest = (a: ThreadListEntry, b: ThreadListEntry) =>
  activityOf(b) - activityOf(a) || byId(a, b);

/** The chats among `entries`, as the Chats panel lists them. */
export function chatList(input: ChatListInput): ChatList {
  const pinned: ThreadListEntry[] = [];
  const groups: [ThreadListEntry[], ThreadListEntry[], ThreadListEntry[]] = [[], [], []];
  const rest: ThreadListEntry[] = [];
  const needsYou: string[] = [];
  for (const entry of input.entries) {
    if (isRemoved(entry) || isDraft(entry) || isRemoteChild(entry) || !input.isChat(entry))
      continue;
    const stands = input.standing(entry);
    if (entry.status.state === "needs_you") needsYou.push(entry.id);
    // Settled yet its tree still works or asks: Active, never dimmed.
    if (isSettled(entry) && atRest(stands)) rest.push(entry);
    else if (entry.pinned === true) pinned.push(entry);
    else groups[needsPerson(stands) ? 0 : atWork(stands) ? 1 : 2].push(entry);
  }
  pinned.sort(
    (a, b) => pinOrderOf(b) - pinOrderOf(a) || activityOf(b) - activityOf(a) || byId(a, b),
  );
  for (const group of groups) group.sort(newest);
  rest.sort(newest);
  return {
    active: [...pinned, ...groups.flat()].map((entry) => entry.id),
    pinned: pinned.map((entry) => entry.id),
    dated: rest.map((entry) => {
      const at = activityOf(entry);
      return { id: entry.id, at, day: chatDayOf(at, input.now) };
    }),
    settled: rest.map((entry) => entry.id),
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
  const held = new Set([...list.active, ...list.dated.map((item) => item.id)]);
  const added = hits.filter((hit) => !held.has(hit.id));
  if (!added.length) return list;
  const dated = [
    ...list.dated,
    ...added.map((hit) => ({ id: hit.id, at: hit.at, day: chatDayOf(hit.at, now) })),
  ].toSorted((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...list, dated, settled: [...list.settled, ...added.map((hit) => hit.id)] };
}

/** The Chats panel's rows: Active, then each day group of settled chats under its heading. */
export function chatRows(list: ChatList): HomeRow[] {
  const settled = new Set(list.settled);
  const row = (id: string): HomeRow => ({ kind: "chat", id, settled: settled.has(id) });
  const rows: HomeRow[] = [];
  if (list.active.length) {
    rows.push({ kind: "active-label" });
    for (const id of list.active) rows.push(row(id));
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
