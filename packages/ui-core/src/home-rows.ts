import type { ThreadsTab } from "./organizer.ts";
import type { ThreadsPanel } from "./threads-panel.ts";

/*
 * The Threads panel's rows as the sidebar draws them (ADR 0107): the open tab's threads, one
 * flat list with no headings. The Inbox puts Unsent on top, then every thread band by band.
 * Snoozed and Settled show a page at a time and end with Show more and Show less. Pure.
 */

/** How many threads Snoozed and Settled show at first, and how many each Show more adds. */
export const panelPage = 50;

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
  /**
   * Snoozed's or Settled's last row while it shows part of its threads (`more`: Show more) or
   * more than its first page (`less`: Show less).
   */
  | { kind: "more"; more: boolean; less: boolean }
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
  /** How many threads Snoozed or Settled shows (`panelPage` at first); unset, all of them. */
  shown?: number | undefined;
  /** The daemon holds older settled threads back: Settled can show more than it has loaded. */
  moreOnDaemon?: boolean | undefined;
}

/** The rows of one tab, top to bottom. */
export function panelRows(
  panel: ThreadsPanel,
  tab: ThreadsTab,
  options: PanelRowOptions = {},
): HomeRow[] {
  if (tab === "snoozed" || tab === "settled") {
    const ids = panel[tab];
    const shown = options.shown ?? ids.length;
    const rows: HomeRow[] = ids
      .slice(0, shown)
      .map((id) => (tab === "snoozed" ? { kind: "snoozed", id } : { kind: "settled", id }));
    const more = ids.length > shown || (tab === "settled" && options.moreOnDaemon === true);
    const less = shown > panelPage && ids.length > panelPage;
    if (more || less) rows.push({ kind: "more", more, less });
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
