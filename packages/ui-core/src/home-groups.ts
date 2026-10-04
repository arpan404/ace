/*
 * The Home list as the sidebar draws it: pinned threads first, then a folder per project with
 * its threads in Home order, then Settled. Pure: the caller passes the arrangement, which
 * folders are closed and which show all their threads.
 */

/** One active thread in Home order, with what grouping needs to know about it. */
export interface GroupEntry {
  id: string;
  project: string;
  pinned: boolean;
  needsYou: boolean;
}

export interface ProjectGroup {
  project: string;
  /** Its threads in Home order. */
  ids: string[];
  /** One of them needs you: a closed folder still says so. */
  needsYou: boolean;
}

export interface HomeGroups {
  pinned: string[];
  /** In the order their first thread comes in Home order: the folder that owes most leads. */
  projects: ProjectGroup[];
}

export function groupHome(active: readonly GroupEntry[]): HomeGroups {
  const pinned: string[] = [];
  const projects = new Map<string, ProjectGroup>();
  for (const entry of active) {
    if (entry.pinned) {
      pinned.push(entry.id);
      continue;
    }
    let group = projects.get(entry.project);
    if (!group) {
      group = { project: entry.project, ids: [], needsYou: false };
      projects.set(entry.project, group);
    }
    group.ids.push(entry.id);
    group.needsYou ||= entry.needsYou;
  }
  return { pinned, projects: [...projects.values()] };
}

export function homeGroupsEqual(a: HomeGroups, b: HomeGroups): boolean {
  return (
    sameIds(a.pinned, b.pinned) &&
    a.projects.length === b.projects.length &&
    a.projects.every((group, index) => {
      const other = b.projects[index];
      return (
        other !== undefined &&
        group.project === other.project &&
        group.needsYou === other.needsYou &&
        sameIds(group.ids, other.ids)
      );
    })
  );
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export type HomeRow =
  | { kind: "pinned-label" }
  | { kind: "pinned"; id: string }
  | { kind: "folder"; project: string; open: boolean; count: number; needsYou: boolean }
  | { kind: "thread"; id: string }
  | { kind: "more"; project: string; hidden: number; showingAll: boolean }
  | { kind: "settled-header"; count: number }
  | { kind: "settled"; id: string };

export interface HomeRowOptions {
  /** Projects whose folder is closed. */
  closed: ReadonlySet<string>;
  /** Projects showing all their threads rather than the first `limit`. */
  showingAll: ReadonlySet<string>;
  /** The open thread shows even past the limit, so it is never hidden in an open folder. */
  open?: string | undefined;
  settledOpen: boolean;
  limit?: number;
}

/** A folder shows this many threads before "Show more". */
export const folderLimit = 5;

/** Every row of the list, top to bottom. */
export function homeRows(
  groups: HomeGroups,
  settled: readonly string[],
  options: HomeRowOptions,
): HomeRow[] {
  const limit = options.limit ?? folderLimit;
  const rows: HomeRow[] = [];
  if (groups.pinned.length) {
    rows.push({ kind: "pinned-label" });
    for (const id of groups.pinned) rows.push({ kind: "pinned", id });
  }
  for (const group of groups.projects) {
    const open = !options.closed.has(group.project);
    rows.push({
      kind: "folder",
      project: group.project,
      open,
      count: group.ids.length,
      needsYou: group.needsYou,
    });
    if (!open) continue;
    const showingAll = options.showingAll.has(group.project);
    const shown = showingAll
      ? group.ids
      : group.ids.filter((id, index) => index < limit || id === options.open);
    for (const id of shown) rows.push({ kind: "thread", id });
    if (group.ids.length > limit)
      rows.push({
        kind: "more",
        project: group.project,
        hidden: group.ids.length - shown.length,
        showingAll,
      });
  }
  rows.push({ kind: "settled-header", count: settled.length });
  if (options.settledOpen) for (const id of settled) rows.push({ kind: "settled", id });
  return rows;
}

/**
 * A stable key per row, for the virtualizer and the list's motion. Each kind has its own prefix,
 * so no thread id (ids are any string) can take a folder's or a heading's key. A thread keeps
 * one key whether it shows pinned, in its folder or settled, so moving between them slides.
 */
export function homeRowKey(row: HomeRow): string {
  switch (row.kind) {
    case "pinned":
    case "thread":
    case "settled":
      return `thread:${row.id}`;
    case "folder":
      return `folder:${row.project}`;
    case "more":
      return `more:${row.project}`;
    default:
      return `section:${row.kind}`;
  }
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return row.kind === "pinned" || row.kind === "thread" || row.kind === "settled"
    ? row.id
    : undefined;
}
