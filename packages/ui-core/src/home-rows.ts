import type { ThreadsTab } from "./organizer.ts";
import type { ThreadsPanel } from "./thread-place.ts";

/*
 * The Threads panel's rows as the sidebar draws them (ADR 0107): the open tab's threads, one
 * flat list with no headings. The Inbox puts Unsent on top, then its threads band by band; the
 * Settled tab ends with a note that older settled threads are in search. Pure.
 */

/** Where an Inbox row shows: among the pinned ones that lead it, or after them. */
export type RowPlace = "pinned" | "active";

/** The Chats panel's day groups, by last activity (`chatDayOf`). */
export type ChatDay = "today" | "yesterday" | "week" | "earlier";

export type HomeRow =
  | { kind: "unsent" }
  /** A thread in the Inbox. */
  | { kind: "thread"; id: string; place: RowPlace }
  /** A thread in Snoozed. */
  | { kind: "snoozed"; id: string }
  /** A thread in Settled. */
  | { kind: "settled"; id: string }
  /** Settled's last row while the daemon holds older ones back: search (⌘K) reaches them. */
  | { kind: "older" }
  | { kind: "empty"; key: string; text: string }
  /** The Chats panel's label over its Active chats. */
  | { kind: "active-label" }
  /** A chat in the Chats panel (`chatRows`); a settled one is dimmed. */
  | { kind: "chat"; id: string; settled: boolean }
  /** The Chats panel's day heading: Today, Yesterday, Previous 7 days, Earlier. */
  | { kind: "day-label"; day: ChatDay };

export interface PanelRowOptions {
  /** Unsent sends, at the Inbox's top. */
  includeUnsent?: boolean | undefined;
  /** The daemon holds older settled threads back: Settled ends by pointing to search. */
  olderInSearch?: boolean | undefined;
}

/** The rows of one tab, top to bottom. */
export function panelRows(
  panel: ThreadsPanel,
  tab: ThreadsTab,
  options: PanelRowOptions = {},
): HomeRow[] {
  if (tab === "snoozed") return panel.snoozed.map((id) => ({ kind: "snoozed", id }));
  if (tab === "settled") {
    const rows: HomeRow[] = panel.settled.map((id) => ({ kind: "settled", id }));
    if (options.olderInSearch) rows.push({ kind: "older" });
    return rows;
  }
  const pinned = new Set(panel.pinned);
  const rows: HomeRow[] = options.includeUnsent ? [{ kind: "unsent" }] : [];
  for (const id of panel.inbox)
    rows.push({ kind: "thread", id, place: pinned.has(id) ? "pinned" : "active" });
  return rows;
}

/** The threads a tab lists, top to bottom: what J and K move through and its count. */
export function tabThreads(panel: ThreadsPanel, tab: ThreadsTab): readonly string[] {
  return tab === "inbox" ? panel.inbox : panel[tab];
}

/**
 * An empty tab's title: "No threads yet" while there is no thread anywhere, else "Inbox zero",
 * "Nothing snoozed" or "Nothing settled", each narrowed to the filter ("in docs") when one is on.
 */
export function emptyTabTitle(
  tab: ThreadsTab,
  narrowed: string | undefined,
  none: boolean,
): string {
  const where = narrowed ? ` ${narrowed}` : "";
  if (none) return narrowed ? `No threads ${narrowed}` : "No threads yet";
  if (tab === "inbox") return `Inbox zero${where}`;
  return tab === "snoozed" ? `Nothing snoozed${where}` : `Nothing settled${where}`;
}

/** The line under an empty Inbox while other threads exist (snoozed, settled or filtered out). */
export const emptyInboxLine = "Nothing needs you, and nothing is running.";

/**
 * A stable key per row, for the virtualizer and the list's motion. Threads and other rows have
 * their own prefixes, so no thread id (ids are any string) can take another row's key. A thread
 * keeps one key wherever it shows, so a row that changes place slides rather than jumps.
 */
export function homeRowKey(row: HomeRow): string {
  if ("id" in row) return `thread:${row.id}`;
  switch (row.kind) {
    case "empty":
      return `section:empty:${row.key}`;
    case "day-label":
      return `section:day:${row.day}`;
    default:
      return `section:${row.kind}`;
  }
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return "id" in row ? row.id : undefined;
}

/** Where a row's thread shows (Pinned, Snoozed…): a change moves it even while rows hold. */
export function homeRowPlace(row: HomeRow): string {
  return row.kind === "thread" ? row.place : row.kind;
}
