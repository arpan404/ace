import type { HomeTree, TreeProject } from "./home-tree.ts";

/*
 * The Threads panel's rows as the sidebar draws them. The tree: Unsent on top, then Projects,
 * each folding open in place with its open threads and its recently settled ones, Quiet
 * projects folded at their foot, and Snoozed last. Search draws its own rows. The Inbox is an
 * overlay over the panel, not rows of it. Pure.
 */

/** Where a thread row shows: its project, or search. */
export type RowPlace = "project" | "search";

export type HomeRow =
  | { kind: "unsent" }
  | { kind: "thread"; id: string; place: RowPlace; withProject: boolean }
  /** A thread settled within the grace period, dimmed in its project. */
  | { kind: "recently-settled"; id: string }
  | { kind: "empty"; key: string; text: string }
  | { kind: "projects-label" }
  | {
      kind: "project-header";
      project: string;
      open: boolean;
      running: number;
      inbox: number;
    }
  /** A one-line settled match in search. */
  | { kind: "settled"; id: string }
  | { kind: "quiet-header"; count: number; open: boolean }
  | { kind: "quiet-project"; project: string }
  | { kind: "snoozed-header"; count: number }
  | { kind: "snoozed"; id: string }
  | { kind: "label"; key: string; label: string; count?: number | undefined };

/** A project's fold key (`Organizer.collapsed`). */
export const projectFold = (id: string) => `project:${id}`;

export interface TreeRowOptions {
  includeUnsent?: boolean | undefined;
  /** Folded projects (`projectFold`). */
  collapsed?: readonly string[] | undefined;
  quietOpen?: boolean | undefined;
  snoozed?: readonly string[] | undefined;
  snoozedOpen?: boolean | undefined;
  /** The open thread: kept in sight under its folded heading, so it never vanishes. */
  current?: string | undefined;
}

const projectThread = (id: string): HomeRow => ({
  kind: "thread",
  id,
  place: "project",
  withProject: false,
});

function projectRows(
  place: TreeProject,
  options: TreeRowOptions,
  folded: ReadonlySet<string>,
): HomeRow[] {
  const open = !folded.has(projectFold(place.id));
  const rows: HomeRow[] = [
    {
      kind: "project-header",
      project: place.id,
      open,
      running: place.running,
      inbox: place.inbox,
    },
  ];
  if (!open) {
    const current = options.current;
    if (current !== undefined && place.threads.includes(current)) rows.push(projectThread(current));
    else if (current !== undefined && place.recent.includes(current))
      rows.push({ kind: "recently-settled", id: current });
    return rows;
  }
  for (const id of place.threads) rows.push(projectThread(id));
  for (const id of place.recent) rows.push({ kind: "recently-settled", id });
  if (!place.threads.length && !place.recent.length)
    rows.push({
      kind: "empty",
      key: `project:${place.id}`,
      text: "Nothing open. Waiting items are in your Inbox.",
    });
  return rows;
}

/** Every row of the tree, top to bottom. */
export function treeRows(tree: HomeTree, options: TreeRowOptions = {}): HomeRow[] {
  const rows: HomeRow[] = [];
  const folded = new Set(options.collapsed ?? []);
  if (options.includeUnsent) rows.push({ kind: "unsent" });
  if (tree.projects.length || tree.quiet.length) rows.push({ kind: "projects-label" });
  for (const place of tree.projects) rows.push(...projectRows(place, options, folded));
  if (tree.quiet.length) {
    rows.push({ kind: "quiet-header", count: tree.quiet.length, open: options.quietOpen === true });
    if (options.quietOpen)
      for (const project of tree.quiet) rows.push({ kind: "quiet-project", project });
  }
  const snoozed = options.snoozed ?? [];
  if (snoozed.length) rows.push({ kind: "snoozed-header", count: snoozed.length });
  const current = options.current;
  for (const id of options.snoozedOpen
    ? snoozed
    : current !== undefined && snoozed.includes(current)
      ? [current]
      : [])
    rows.push({ kind: "snoozed", id });
  return rows;
}

/** Search: the open threads that match ("Threads · N"), then the settled ones ("Settled · N"). */
export function searchRows(threads: readonly string[], settled: readonly string[]): HomeRow[] {
  const rows: HomeRow[] = [];
  if (threads.length) {
    rows.push({ kind: "label", key: "threads", label: "Threads", count: threads.length });
    for (const id of threads) rows.push({ kind: "thread", id, place: "search", withProject: true });
  }
  if (settled.length) {
    rows.push({ kind: "label", key: "settled", label: "Settled", count: settled.length });
    for (const id of settled) rows.push({ kind: "settled", id });
  }
  return rows;
}

/**
 * Where the foot section begins: the Snoozed heading. When the list is shorter than the
 * sidebar, rows from here on sit at its bottom, below the free space, as on a shelf.
 */
export function homeFootStart(rows: readonly { item: HomeRow }[]): number {
  return rows.findIndex((row) => row.item.kind === "snoozed-header");
}

/**
 * A stable key per row, for the virtualizer and the list's motion. Threads and headings have
 * their own prefixes, so no thread id (ids are any string) can take a heading's key. A thread
 * keeps one key wherever it shows, so settling it in its project slides rather than jumps.
 */
export function homeRowKey(row: HomeRow): string {
  if ("id" in row) return `thread:${row.id}`;
  switch (row.kind) {
    case "project-header":
      return `section:project:${row.project}`;
    case "quiet-project":
      return `section:quiet:${row.project}`;
    case "empty":
      return `section:empty:${row.key}`;
    case "label":
      return `section:label:${row.key}`;
    default:
      return `section:${row.kind}`;
  }
}

/** The thread a row shows, if it shows one. */
export function homeRowThread(row: HomeRow): string | undefined {
  return "id" in row ? row.id : undefined;
}

/** Where a row's thread shows (a project, search…): a change moves it even while rows hold. */
export function homeRowPlace(row: HomeRow): string {
  return row.kind === "thread" ? row.place : row.kind;
}
