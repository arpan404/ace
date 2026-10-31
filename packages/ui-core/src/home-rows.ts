import {
  recentGroupLabels,
  recentGroupOf,
  type HomeFocus,
  type HomeTree,
  type RecentItem,
  type TreeProject,
} from "./home-tree.ts";

/*
 * The Threads panel's rows as the sidebar draws them. The tree: Unsent on top, the Inbox with
 * its threads, the Running and Recent places, then Projects, each folding open in place with
 * its threads and its own "N settled", Quiet projects folded at their foot, and Snoozed last.
 * A focused list (a place, or one project's tab) and search draw their own rows. Pure.
 */

/** Where a thread row shows: the Inbox, a place, a project, or search. */
export type RowPlace = "inbox" | "running" | "project" | "search";

export type HomeRow =
  | { kind: "unsent" }
  | { kind: "inbox-header"; count: number; open: boolean }
  | { kind: "thread"; id: string; place: RowPlace; withProject: boolean }
  | { kind: "empty"; key: string; text: string }
  | { kind: "place"; place: "running" | "recent"; count: number }
  | { kind: "projects-label" }
  | {
      kind: "project-header";
      project: string;
      open: boolean;
      running: number;
      inbox: number;
    }
  | { kind: "project-settled"; project: string; count: number; open: boolean }
  /** A one-line row: a settled thread, or a finished one in Recent. */
  | { kind: "settled"; id: string; withProject: boolean; settled: boolean }
  | { kind: "settled-more"; key: string; state: "more" | "loading" | "error" }
  | { kind: "quiet-header"; count: number; open: boolean }
  | { kind: "quiet-project"; project: string; settled: number }
  | { kind: "snoozed-header"; count: number }
  | { kind: "snoozed"; id: string }
  | { kind: "label"; key: string; label: string; count?: number | undefined };

/** A fold key for the Inbox or a project (`Organizer.collapsed`). */
export const inboxFold = "inbox";
export const projectFold = (id: string) => `project:${id}`;

/** How far older settled threads of one list have loaded. */
export type SettledFoot = "more" | "loading" | "error" | undefined;

export interface TreeRowOptions {
  includeUnsent?: boolean | undefined;
  /** Folded places (`inboxFold`, `projectFold`). */
  collapsed?: readonly string[] | undefined;
  /** Projects whose "N settled" is open. */
  settledOpen?: readonly string[] | undefined;
  quietOpen?: boolean | undefined;
  snoozed?: readonly string[] | undefined;
  snoozedOpen?: boolean | undefined;
  /** The open thread: kept in sight under its folded heading, so it never vanishes. */
  current?: string | undefined;
  /** How far one open project's older settled threads have loaded. */
  settledFoot?: ((project: string) => SettledFoot) | undefined;
}

const projectThread = (id: string): HomeRow => ({
  kind: "thread",
  id,
  place: "project",
  withProject: false,
});
const inboxThread = (id: string): HomeRow => ({
  kind: "thread",
  id,
  place: "inbox",
  withProject: true,
});
const threadRows = (ids: readonly string[], place: RowPlace, withProject: boolean): HomeRow[] =>
  ids.map((id) => ({ kind: "thread", id, place, withProject }));
const emptyRows = (text: string): HomeRow[] => [{ kind: "empty", key: "focus", text }];

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
  const thread = projectThread;
  if (!open) {
    const current = options.current;
    if (current !== undefined && place.threads.includes(current)) rows.push(thread(current));
    return rows;
  }
  for (const id of place.threads) rows.push(thread(id));
  if (!place.threads.length)
    rows.push({ kind: "empty", key: `project:${place.id}`, text: "No open threads." });
  if (place.settledTotal > 0) {
    const shown = (options.settledOpen ?? []).includes(place.id);
    rows.push({
      kind: "project-settled",
      project: place.id,
      count: place.settledTotal,
      open: shown,
    });
    if (shown) {
      for (const id of place.settled)
        rows.push({ kind: "settled", id, withProject: false, settled: true });
      const foot = place.settled.length < place.settledTotal && options.settledFoot?.(place.id);
      if (foot) rows.push({ kind: "settled-more", key: place.id, state: foot });
    }
  }
  return rows;
}

/** Every row of the tree, top to bottom. */
export function treeRows(tree: HomeTree, options: TreeRowOptions = {}): HomeRow[] {
  const rows: HomeRow[] = [];
  const folded = new Set(options.collapsed ?? []);
  if (options.includeUnsent) rows.push({ kind: "unsent" });
  const inboxOpen = !folded.has(inboxFold);
  rows.push({ kind: "inbox-header", count: tree.inbox.length, open: inboxOpen });
  if (inboxOpen) {
    for (const id of tree.inbox) rows.push(inboxThread(id));
    if (!tree.inbox.length)
      rows.push({ kind: "empty", key: "inbox", text: "You’re all caught up." });
  } else if (options.current !== undefined && tree.inbox.includes(options.current)) {
    rows.push(inboxThread(options.current));
  }
  rows.push({ kind: "place", place: "running", count: tree.running.length });
  rows.push({ kind: "place", place: "recent", count: tree.recent.length });
  if (tree.projects.length || tree.quiet.length) rows.push({ kind: "projects-label" });
  for (const place of tree.projects) rows.push(...projectRows(place, options, folded));
  if (tree.quiet.length) {
    rows.push({ kind: "quiet-header", count: tree.quiet.length, open: options.quietOpen === true });
    if (options.quietOpen)
      for (const place of tree.quiet)
        rows.push({ kind: "quiet-project", project: place.id, settled: place.settledTotal });
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

/** Recent's rows: newest first under Today, Yesterday and Earlier this week. */
export function recentRows(items: readonly RecentItem[], now: number): HomeRow[] {
  const rows: HomeRow[] = [];
  let last: string | undefined;
  for (const item of items) {
    const group = recentGroupOf(item.at, now);
    if (group !== last) {
      rows.push({ kind: "label", key: `recent:${group}`, label: recentGroupLabels[group] });
      last = group;
    }
    rows.push({ kind: "settled", id: item.id, withProject: true, settled: item.settled });
  }
  return rows;
}

export interface FocusRowInput {
  tree: HomeTree;
  now: number;
  /** How far the focused list's older settled threads have loaded. */
  foot?: SettledFoot;
}

/** Every row of a focused list. */
export function focusRows(focus: HomeFocus, input: FocusRowInput): HomeRow[] {
  const { tree } = input;
  const threads = threadRows;
  const empty = emptyRows;
  if (focus.kind === "inbox")
    return tree.inbox.length ? threads(tree.inbox, "inbox", true) : empty("You’re all caught up.");
  if (focus.kind === "running")
    return tree.running.length
      ? threads(tree.running, "running", true)
      : empty("Nothing is running.");
  if (focus.kind === "recent") {
    const rows = recentRows(tree.recent, input.now);
    if (input.foot) rows.push({ kind: "settled-more", key: "recent", state: input.foot });
    return rows.length ? rows : empty("Nothing finished in the last 7 days.");
  }
  const place = [...tree.projects, ...tree.quiet].find((each) => each.id === focus.id);
  if (focus.tab === "active")
    return place?.open.length ? threads(place.open, "project", false) : empty("No open threads.");
  const rows: HomeRow[] = (place?.settled ?? []).map((id) => ({
    kind: "settled",
    id,
    withProject: false,
    settled: true,
  }));
  if (input.foot) rows.push({ kind: "settled-more", key: focus.id, state: input.foot });
  return rows.length ? rows : empty("No settled threads.");
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
    for (const id of settled) rows.push({ kind: "settled", id, withProject: true, settled: true });
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
 * keeps one key wherever it shows, so moving from the Inbox into its project slides.
 */
export function homeRowKey(row: HomeRow): string {
  if ("id" in row) return `thread:${row.id}`;
  switch (row.kind) {
    case "project-header":
      return `section:project:${row.project}`;
    case "project-settled":
      return `section:project-settled:${row.project}`;
    case "quiet-project":
      return `section:quiet:${row.project}`;
    case "place":
      return `section:place:${row.place}`;
    case "empty":
      return `section:empty:${row.key}`;
    case "settled-more":
      return `section:more:${row.key}`;
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

/** Where a row's thread shows (Inbox, a project…): a change moves it even while rows hold. */
export function homeRowPlace(row: HomeRow): string {
  return row.kind === "thread" ? row.place : row.kind;
}
