import type { HomeTree, TreeProject } from "./home-tree.ts";

/*
 * The Threads panel's rows as the sidebar draws them. The tree: Unsent on top, then Pinned, then
 * Projects, each folding open in place with its open threads and its recently settled ones (five
 * at a time, then Show more), Quiet projects folded at their foot, and Snoozed last. The Inbox is
 * an overlay over the panel, not rows of it. Pure.
 */

/** Where a thread row shows: the Pinned section, or its project. */
export type RowPlace = "pinned" | "project";

/** The Chats panel's day groups, by last activity (`chatDayOf`). */
export type ChatDay = "today" | "yesterday" | "week" | "earlier";

export type HomeRow =
  | { kind: "unsent" }
  | { kind: "thread"; id: string; place: RowPlace }
  /** A thread settled within the grace period, dimmed in its project. */
  | { kind: "recently-settled"; id: string }
  | { kind: "empty"; key: string; text: string }
  | { kind: "pinned-label" }
  | { kind: "projects-label" }
  | {
      kind: "project-header";
      project: string;
      open: boolean;
      running: number;
      inbox: number;
    }
  /** Past a project's first few rows: how many more it holds, or that all of them show. */
  | { kind: "show-more"; project: string; hidden: number; open: boolean }
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
  /**
   * Pinned threads, in pin order. Those the tree shows open lead the panel under Pinned and
   * leave their projects; one waiting in the Inbox stays there (never both).
   */
  pinned?: readonly string[] | undefined;
  /** Folded projects (`projectFold`), and those showing every row (`projectMore`). */
  collapsed?: readonly string[] | undefined;
  quietOpen?: boolean | undefined;
  snoozed?: readonly string[] | undefined;
  snoozedOpen?: boolean | undefined;
  /** The open thread: kept in sight under its folded heading or past Show more. */
  current?: string | undefined;
}

type ProjectRow = Extract<HomeRow, { kind: "thread" | "recently-settled" }>;

function projectRows(
  place: TreeProject,
  options: TreeRowOptions,
  folded: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
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
  const own: ProjectRow[] = [
    ...place.threads
      .filter((id) => !pinned.has(id))
      .map((id): ProjectRow => ({ kind: "thread", id, place: "project" })),
    ...place.recent.map((id): ProjectRow => ({ kind: "recently-settled", id })),
  ];
  const current = options.current;
  const isCurrent = (row: ProjectRow) => current !== undefined && row.id === current;
  if (!open) return [...rows, ...own.filter(isCurrent)];
  if (!place.threads.length && !place.recent.length)
    return [
      ...rows,
      {
        kind: "empty",
        key: `project:${place.id}`,
        text: "Nothing open. Waiting items are in your Inbox.",
      },
    ];
  if (own.length <= projectRowLimit) return [...rows, ...own];
  if (folded.has(projectMore(place.id)))
    return [...rows, ...own, { kind: "show-more", project: place.id, hidden: 0, open: true }];
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
  const open = new Set(tree.projects.flatMap((place) => place.threads));
  const pinned = (options.pinned ?? []).filter((id) => open.has(id));
  if (pinned.length) {
    rows.push({ kind: "pinned-label" });
    for (const id of pinned) rows.push({ kind: "thread", id, place: "pinned" });
  }
  const lead = new Set(pinned);
  if (tree.projects.length || tree.quiet.length) rows.push({ kind: "projects-label" });
  for (const place of tree.projects) rows.push(...projectRows(place, options, folded, lead));
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
