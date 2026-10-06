/*
 * The Home list as the sidebar draws it: the Pinned group under its heading, in the person's
 * own order, then the rest in Home order (what needs you, work in motion, trouble, the rest, most
 * recent first within each), then the collapsible Settled section. Pure: the caller passes the
 * arrangement.
 */

export type HomeRow =
  | { kind: "pinned-header"; count: number }
  | { kind: "pinned"; id: string }
  | { kind: "pinned-end" }
  | { kind: "thread"; id: string }
  | { kind: "settled-header"; count: number }
  | { kind: "settled"; id: string };

export interface HomeGroups {
  pinned: readonly string[];
  active: readonly string[];
  settled: readonly string[];
}

/**
 * Every row of the list, top to bottom. The Pinned heading shows while anything is pinned, and
 * during a drag (`pinZone`) even when nothing is, as the place to drop a thread to pin it. A
 * rule closes the group.
 */
export function homeRows(
  groups: HomeGroups,
  options: { settledOpen: boolean; pinZone?: boolean },
): HomeRow[] {
  const rows: HomeRow[] = [];
  const pinnedGroup = groups.pinned.length > 0 || options.pinZone === true;
  if (pinnedGroup) rows.push({ kind: "pinned-header", count: groups.pinned.length });
  for (const id of groups.pinned) rows.push({ kind: "pinned", id });
  if (pinnedGroup) rows.push({ kind: "pinned-end" });
  for (const id of groups.active) rows.push({ kind: "thread", id });
  rows.push({ kind: "settled-header", count: groups.settled.length });
  if (options.settledOpen) for (const id of groups.settled) rows.push({ kind: "settled", id });
  return rows;
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
