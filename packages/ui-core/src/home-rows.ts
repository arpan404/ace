/*
 * The Home list as the sidebar draws it: the Unsent block on top, where it's seen, then the
 * Pinned group under its heading, in the person's own order, then the work in hand in Home order
 * (what needs you, work in motion, trouble, most recent first within each), then threads at
 * rest, then the collapsible Snoozed and Settled sections at the foot. Pure: the caller passes
 * the arrangement.
 */

export type HomeRow =
  | { kind: "pinned-header"; count: number }
  | { kind: "pinned"; id: string }
  | { kind: "pinned-end" }
  | { kind: "thread"; id: string }
  | { kind: "unsent" }
  | { kind: "snoozed-header"; count: number }
  | { kind: "snoozed"; id: string }
  | { kind: "settled-header"; count: number }
  | { kind: "settled"; id: string }
  | { kind: "settled-more"; count: number };

export interface HomeGroups {
  pinned: readonly string[];
  active: readonly string[];
  recent: readonly string[];
  snoozed: readonly string[];
  settled: readonly string[];
}

/** How many settled threads an opened Settled section shows at first. */
export const settledFirstRows = 10;
/** How many more each "Show more" reveals. */
export const settledMoreRows = 25;

export interface HomeRowOptions {
  snoozedOpen?: boolean;
  settledOpen: boolean;
  pinZone?: boolean;
  includeUnsent?: boolean;
  /** How many settled threads the open section shows; every loaded one when left out. */
  settledShown?: number | undefined;
  /** Settled threads in all, loaded or not (the daemon's count); the loaded ones when left out. */
  settledTotal?: number | undefined;
  /** The open thread: kept in sight under its section's heading while the section is closed. */
  current?: string | undefined;
}

/**
 * Every row of the list, top to bottom. The Pinned heading shows while anything is pinned, and
 * during a drag (`pinZone`) even when nothing is, as the place to drop a thread to pin it. A
 * rule closes the group. Unsettled tasks follow without a heading. Snoozed and Settled close the
 * list; a closed section still shows the open thread, so the thread in view never vanishes. An
 * open Settled section shows `settledShown` rows, then a "Show more" row while more remain.
 */
export function homeRows(groups: HomeGroups, options: HomeRowOptions): HomeRow[] {
  const rows: HomeRow[] = [];
  if (options.includeUnsent) rows.push({ kind: "unsent" });
  const pinnedGroup = groups.pinned.length > 0 || options.pinZone === true;
  if (pinnedGroup) rows.push({ kind: "pinned-header", count: groups.pinned.length });
  for (const id of groups.pinned) rows.push({ kind: "pinned", id });
  if (pinnedGroup) rows.push({ kind: "pinned-end" });
  for (const id of groups.active) rows.push({ kind: "thread", id });
  for (const id of groups.recent) rows.push({ kind: "thread", id });
  const kept = (ids: readonly string[]) =>
    options.current !== undefined && ids.includes(options.current) ? [options.current] : [];
  if (groups.snoozed.length) rows.push({ kind: "snoozed-header", count: groups.snoozed.length });
  for (const id of options.snoozedOpen ? groups.snoozed : kept(groups.snoozed))
    rows.push({ kind: "snoozed", id });
  const total = Math.max(groups.settled.length, options.settledTotal ?? 0);
  if (total) rows.push({ kind: "settled-header", count: total });
  if (!options.settledOpen) {
    for (const id of kept(groups.settled)) rows.push({ kind: "settled", id });
    return rows;
  }
  const shown = groups.settled.slice(0, options.settledShown ?? groups.settled.length);
  // The open thread stays in sight even when it is further down than the section shows.
  const extra = kept(groups.settled).filter((id) => !shown.includes(id));
  for (const id of [...shown, ...extra]) rows.push({ kind: "settled", id });
  const hidden = total - shown.length - extra.length;
  if (hidden > 0) rows.push({ kind: "settled-more", count: Math.min(hidden, settledMoreRows) });
  return rows;
}

/**
 * Where the foot sections begin: the first Snoozed or Settled row. When the list is shorter
 * than the sidebar, rows from here on sit at its bottom, below the free space, as in a shelf.
 */
export function homeFootStart(rows: readonly { item: HomeRow }[]): number {
  return rows.findIndex(
    (row) => row.item.kind === "snoozed-header" || row.item.kind === "settled-header",
  );
}

/**
 * A stable key per row, for the virtualizer and the list's motion. Threads and headings have
 * their own prefixes, so no thread id (ids are any string) can take a heading's key. A thread
 * keeps one key whether it shows pinned, active or settled, so moving between them slides.
 */
export function homeRowKey(row: HomeRow): string {
  return "id" in row ? `thread:${row.id}` : `section:${row.kind}`;
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return "id" in row ? row.id : undefined;
}
