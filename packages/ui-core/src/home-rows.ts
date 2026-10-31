import {
  activeGroupKeys,
  weekGroupOf,
  type ActiveGroupKey,
  type ActiveGroups,
} from "./home-groups.ts";

/*
 * The Threads panel as the sidebar draws it, one tab at a time. Active: the Unsent block on top,
 * the Pinned group in the person's own order, then the groups (Needs you, Running, Today,
 * Yesterday, This week, Earlier) under quiet collapsible headings, and Snoozed folded at the
 * foot. Settled: settled threads under week and month headings, and a row at the end while
 * older ones load. Pure: the caller passes the arrangement and the clock.
 */

export type HomeRow =
  | { kind: "pinned-header"; count: number }
  | { kind: "pinned"; id: string }
  | { kind: "pinned-end" }
  | { kind: "group-header"; group: ActiveGroupKey; count: number; open: boolean }
  | { kind: "thread"; id: string; group: ActiveGroupKey }
  | { kind: "unsent" }
  | { kind: "snoozed-header"; count: number }
  | { kind: "snoozed"; id: string }
  | { kind: "settled-header"; key: string; label: string; count?: number | undefined }
  | { kind: "settled"; id: string }
  | { kind: "settled-more"; state: "loading" | "error" };

export interface ActiveRowGroups {
  pinned: readonly string[];
  groups: ActiveGroups;
  snoozed: readonly string[];
}

export interface ActiveRowOptions {
  snoozedOpen?: boolean | undefined;
  /** Groups the person folded (`ActiveGroupKey`s). */
  collapsed?: readonly string[] | undefined;
  pinZone?: boolean | undefined;
  includeUnsent?: boolean | undefined;
  /** The open thread: kept in sight under its group's heading while the group is folded. */
  current?: string | undefined;
  /**
   * While searching: the settled threads that match, listed after the active matches under a
   * "Settled" heading with their count.
   */
  settledMatches?: readonly string[] | undefined;
}

/**
 * Every row of the Active tab, top to bottom. The Pinned heading shows while anything is pinned,
 * and during a drag (`pinZone`) even when nothing is, as the place to drop a thread to pin it. A
 * rule closes the group. Each other group shows under its heading only while it has threads; a
 * folded group keeps its heading and the open thread, so the thread in view never vanishes.
 * Snoozed closes the list.
 */
export function activeRows(groups: ActiveRowGroups, options: ActiveRowOptions = {}): HomeRow[] {
  const rows: HomeRow[] = [];
  if (options.includeUnsent) rows.push({ kind: "unsent" });
  const pinnedGroup = groups.pinned.length > 0 || options.pinZone === true;
  if (pinnedGroup) rows.push({ kind: "pinned-header", count: groups.pinned.length });
  for (const id of groups.pinned) rows.push({ kind: "pinned", id });
  if (pinnedGroup) rows.push({ kind: "pinned-end" });
  const kept = (ids: readonly string[]) =>
    options.current !== undefined && ids.includes(options.current) ? [options.current] : [];
  const collapsed = new Set(options.collapsed ?? []);
  for (const group of activeGroupKeys) {
    const ids = groups.groups[group];
    if (!ids.length) continue;
    // The hand-sorted list has no heading, so it never folds.
    const open = group === "listed" || !collapsed.has(group);
    if (group !== "listed") rows.push({ kind: "group-header", group, count: ids.length, open });
    for (const id of open ? ids : kept(ids)) rows.push({ kind: "thread", id, group });
  }
  if (groups.snoozed.length) rows.push({ kind: "snoozed-header", count: groups.snoozed.length });
  for (const id of options.snoozedOpen ? groups.snoozed : kept(groups.snoozed))
    rows.push({ kind: "snoozed", id });
  const matches = options.settledMatches ?? [];
  if (matches.length) {
    rows.push({ kind: "settled-header", key: "matches", label: "Settled", count: matches.length });
    for (const id of matches) rows.push({ kind: "settled", id });
  }
  return rows;
}

export interface SettledItem {
  id: string;
  /** When it last worked: what places it in its week or month. */
  at: number;
}

/**
 * Every row of the Settled tab: the threads (newest first) under a heading for each week or
 * month they fall in (`weekGroupOf`), then, while older ones are loading or failed to load, a
 * row saying so.
 */
export function settledRows(
  items: readonly SettledItem[],
  now: number,
  foot?: "loading" | "error" | undefined,
): HomeRow[] {
  const rows: HomeRow[] = [];
  let last: string | undefined;
  for (const item of items) {
    const group = weekGroupOf(item.at, now);
    if (group.key !== last) {
      rows.push({ kind: "settled-header", key: group.key, label: group.label });
      last = group.key;
    }
    rows.push({ kind: "settled", id: item.id });
  }
  if (foot) rows.push({ kind: "settled-more", state: foot });
  return rows;
}

/**
 * Where the foot section begins: the Snoozed heading. When the list is shorter than the
 * sidebar, rows from here on sit at its bottom, below the free space, as in a shelf.
 */
export function homeFootStart(rows: readonly { item: HomeRow }[]): number {
  return rows.findIndex((row) => row.item.kind === "snoozed-header");
}

/**
 * A stable key per row, for the virtualizer and the list's motion. Threads and headings have
 * their own prefixes, so no thread id (ids are any string) can take a heading's key. A thread
 * keeps one key in whichever group it shows, so moving between groups slides.
 */
export function homeRowKey(row: HomeRow): string {
  if ("id" in row) return `thread:${row.id}`;
  if (row.kind === "group-header") return `section:group:${row.group}`;
  if (row.kind === "settled-header") return `section:settled:${row.key}`;
  return `section:${row.kind}`;
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return "id" in row ? row.id : undefined;
}
