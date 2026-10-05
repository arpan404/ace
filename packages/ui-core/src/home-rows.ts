/*
 * The Home list as the sidebar draws it: one flat list of task rows, pinned threads first, then
 * the rest in Home order (what needs you, work in motion, trouble, the rest, most recent first
 * within each), then the collapsible Settled section. Pure: the caller passes the arrangement.
 */

/** One active thread in Home order, with what the list order needs to know about it. */
export interface HomeEntry {
  id: string;
  pinned: boolean;
}

/** Pinned threads lead, each part keeping Home order. */
export function homeOrder(active: readonly HomeEntry[]): string[] {
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const entry of active) (entry.pinned ? pinned : rest).push(entry.id);
  return [...pinned, ...rest];
}

export type HomeRow =
  | { kind: "thread"; id: string }
  | { kind: "settled-header"; count: number }
  | { kind: "settled"; id: string };

/** Every row of the list, top to bottom. */
export function homeRows(
  active: readonly string[],
  settled: readonly string[],
  options: { settledOpen: boolean },
): HomeRow[] {
  const rows: HomeRow[] = active.map((id) => ({ kind: "thread", id }));
  rows.push({ kind: "settled-header", count: settled.length });
  if (options.settledOpen) for (const id of settled) rows.push({ kind: "settled", id });
  return rows;
}

/**
 * A stable key per row, for the virtualizer and the list's motion. Threads and headings have
 * their own prefixes, so no thread id (ids are any string) can take a heading's key. A thread
 * keeps one key whether it shows active or settled, so moving between them slides.
 */
export function homeRowKey(row: HomeRow): string {
  return row.kind === "settled-header" ? "section:settled-header" : `thread:${row.id}`;
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return row.kind === "settled-header" ? undefined : row.id;
}
