import type { HomeTree, TreeProject } from "./home-tree.ts";

/*
 * The Threads panel's rows as the sidebar draws them (ADR 0107). Unsent on top, then Active:
 * every unsettled thread across projects, each row with its project's mark. Then Projects, each
 * folding open in place with only its settled threads (five at a time, then Show more, and the
 * rest in History), Quiet projects folded at their foot, and Snoozed last. Pure.
 */

/** Where a thread row shows in Active: among the pinned ones that lead it, or after them. */
export type RowPlace = "pinned" | "active";

/** The Chats panel's day groups, by last activity (`chatDayOf`). */
export type ChatDay = "today" | "yesterday" | "week" | "earlier";

export type HomeRow =
  | { kind: "unsent" }
  /** An unsettled thread in Active. */
  | { kind: "thread"; id: string; place: RowPlace }
  /** A settled thread in its project. */
  | { kind: "settled"; id: string }
  | { kind: "empty"; key: string; text: string }
  /** Active's label, over every unsettled thread (or chat). */
  | { kind: "active-label" }
  | { kind: "projects-label" }
  | {
      kind: "project-header";
      project: string;
      open: boolean;
      /** How many of its threads are in Active. */
      active: number;
    }
  /** Past a project's first few rows: how many more it holds, or that all of them show. */
  | { kind: "show-more"; project: string; hidden: number; open: boolean }
  /** A project's settled threads the daemon holds back: History has them. */
  | { kind: "project-history"; project: string; count: number }
  | { kind: "quiet-header"; count: number; open: boolean }
  | { kind: "quiet-project"; project: string }
  | { kind: "snoozed-header"; count: number }
  | { kind: "snoozed"; id: string }
  /** A chat in the Chats panel (`chatRows`); a settled one is dimmed. */
  | { kind: "chat"; id: string; settled: boolean }
  /** The Chats panel's day heading: Today, Yesterday, Previous 7 days, Earlier. */
  | { kind: "day-label"; day: ChatDay };

/** A project's fold key (`Organizer.collapsed`). */
export const projectFold = (id: string) => `project:${id}`;

/** Kept with the folds (`Organizer.collapsed`): the project shows all its rows, past Show more. */
export const projectMore = (id: string) => `more:${id}`;

/** How many rows an open project shows before Show more. */
export const projectRowLimit = 5;

export interface TreeRowOptions {
  includeUnsent?: boolean | undefined;
  /** Pinned threads, in pin order: those in Active lead it. */
  pinned?: readonly string[] | undefined;
  /** Folded projects (`projectFold`), and those showing every row (`projectMore`). */
  collapsed?: readonly string[] | undefined;
  quietOpen?: boolean | undefined;
  snoozed?: readonly string[] | undefined;
  snoozedOpen?: boolean | undefined;
  /** The open thread: kept in sight under its folded heading or past Show more. */
  current?: string | undefined;
}

type SettledRow = Extract<HomeRow, { kind: "settled" }>;

function projectRows(
  place: TreeProject,
  options: TreeRowOptions,
  folded: ReadonlySet<string>,
): HomeRow[] {
  const open = !folded.has(projectFold(place.id));
  const rows: HomeRow[] = [
    { kind: "project-header", project: place.id, open, active: place.active },
  ];
  const own = place.settled.map((id): SettledRow => ({ kind: "settled", id }));
  const current = options.current;
  const isCurrent = (row: SettledRow) => current !== undefined && row.id === current;
  if (!open) return [...rows, ...own.filter(isCurrent)];
  const history: HomeRow[] = place.held
    ? [{ kind: "project-history", project: place.id, count: place.held }]
    : [];
  // All its threads in Active: the project's row alone (its count says how many).
  if (!own.length) return [...rows, ...history];
  if (own.length <= projectRowLimit) return [...rows, ...own, ...history];
  if (folded.has(projectMore(place.id)))
    return [
      ...rows,
      ...own,
      { kind: "show-more", project: place.id, hidden: 0, open: true },
      ...history,
    ];
  const shown = own.filter((row, index) => index < projectRowLimit || isCurrent(row));
  return [
    ...rows,
    ...shown,
    { kind: "show-more", project: place.id, hidden: own.length - shown.length, open: false },
  ];
}

/** Every row of the tree, top to bottom. */
export function treeRows(tree: HomeTree, options: TreeRowOptions = {}): HomeRow[] {
  const rows: HomeRow[] = [];
  const folded = new Set(options.collapsed ?? []);
  if (options.includeUnsent) rows.push({ kind: "unsent" });
  const pinned = new Set(options.pinned ?? []);
  if (tree.active.length) {
    rows.push({ kind: "active-label" });
    for (const id of tree.active)
      rows.push({ kind: "thread", id, place: pinned.has(id) ? "pinned" : "active" });
  }
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
    case "show-more":
      return `section:more:${row.project}`;
    case "project-history":
      return `section:history:${row.project}`;
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

/** Where a row's thread shows (Pinned, a project…): a change moves it even while rows hold. */
export function homeRowPlace(row: HomeRow): string {
  return row.kind === "thread" ? row.place : row.kind;
}
