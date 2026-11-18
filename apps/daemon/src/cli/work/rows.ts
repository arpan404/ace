import type { ThreadListEntry, ThreadListWindow } from "@ace/protocol";
import {
  activityOf,
  arrange,
  isSettled,
  rowStatusLook,
  rowStatusState,
  threadCard,
  type RowStatusIconKind,
  type RowStatusState,
  type RowStatusTone,
} from "@ace/ui-core";

/**
 * The thread list as the app's Inbox orders and marks it (ADR 0178 §3, §7), from the daemon's
 * list entries. Status comes from `@ace/ui-core`'s card, attention and row-look rules, the
 * same code the app runs, so a parent whose subagent still works never reads as done. Pure:
 * the caller passes the clock.
 */
export interface ThreadRow {
  readonly threadId: string;
  readonly title: string;
  readonly project: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly branch: string | undefined;
  readonly pinned: boolean;
  readonly settled: boolean;
  /** The row's state, as one word a script can test. */
  readonly state: RowStatusState;
  /** What the row's mark says in words ("Needs approval", "Working"). */
  readonly meaning: string;
  readonly icon: RowStatusIconKind | "none";
  readonly tone: RowStatusTone;
  /** How many agents it waits on, for `◌3`. */
  readonly waitingOn: number | undefined;
  /** When the running time started, for working and waiting rows. */
  readonly since: number | undefined;
  /** The last activity, for the age a resting row shows. */
  readonly activityAt: number;
}

export interface RowFilter {
  readonly needsYou?: boolean;
  readonly running?: boolean;
  /** Only settled threads; without it they are left out, as the Inbox leaves them out. */
  readonly settled?: boolean;
}

export interface RowsInput {
  readonly entries: readonly ThreadListEntry[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly now: number;
  /** Activity before this counts as seen: the CLI keeps no read cursor of its own. */
  readonly baseline: number;
  readonly filter?: RowFilter;
}

export interface Rows {
  readonly rows: readonly ThreadRow[];
  /** Left out of the default list: settled and snoozed, so the hint can say how many. */
  readonly settled: number;
  readonly snoozed: number;
}

/** How long a finished result stays "finished unseen" in a terminal that never reads it. */
export const unseenWindowMs = 24 * 60 * 60 * 1000;

const running: ReadonlySet<RowStatusState> = new Set([
  "working",
  "waiting",
  "limited",
  "background",
]);

/** Pinned, then needs you, then running, then finished unseen, then the rest by recency. */
function band(row: ThreadRow): number {
  if (row.pinned) return 0;
  if (row.state === "needs-you") return 1;
  if (running.has(row.state)) return 2;
  if (row.state === "finished" || row.state === "failed") return 3;
  return 4;
}

export function threadRows(input: RowsInput): Rows {
  const { entries, now } = input;
  const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
  const arranged = arrange(entries, { project: null }, now);
  const filter = input.filter ?? {};
  const wanted = filter.settled
    ? arranged.settled
    : [...arranged.pinned, ...arranged.active, ...arranged.recent];
  const pinnedOrder = new Map(arranged.pinned.map((id, index) => [id, index]));
  const rows = wanted.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [toRow(entry, input)] : [];
  });
  const kept = rows.filter((each) => {
    if (!filter.needsYou && !filter.running) return true;
    return (
      (filter.needsYou === true && each.state === "needs-you") ||
      (filter.running === true && running.has(each.state))
    );
  });
  kept.sort(
    (a, b) =>
      band(a) - band(b) ||
      (pinnedOrder.get(a.threadId) ?? 0) - (pinnedOrder.get(b.threadId) ?? 0) ||
      b.activityAt - a.activityAt ||
      (a.threadId < b.threadId ? -1 : 1),
  );
  return {
    rows: kept,
    settled: filter.settled ? 0 : arranged.settled.length,
    snoozed: arranged.snoozed.length,
  };
}

function toRow(entry: ThreadListEntry, input: RowsInput): ThreadRow {
  const settled = isSettled(entry);
  const projectName = input.projectNames.get(entry.workspaceId);
  const card = threadCard({
    entry,
    baseline: input.baseline,
    settled,
    now: input.now,
    ...(projectName ? { projectName } : {}),
  });
  const look = rowStatusLook(card.attention, card);
  const busy = look.mode === "elapsed";
  return {
    threadId: entry.id,
    title: card.title,
    project: card.project,
    workspaceId: entry.workspaceId,
    provider: card.providerLabel,
    branch: entry.details?.branch ?? undefined,
    pinned: entry.pinned === true,
    settled,
    state: rowStatusState(card.attention, look),
    meaning: look.meaning,
    icon: look.icon,
    tone: look.tone,
    waitingOn: look.count,
    since: busy ? (card.status.since ?? card.pill?.since) : undefined,
    activityAt: activityOf(entry),
  };
}

/** One page of rows after `after` (a thread id), and the cursor for the next. Pure. */
export function pageRows(
  rows: readonly ThreadRow[],
  limit: number,
  after: string | undefined,
): { rows: readonly ThreadRow[]; next: string | null } {
  const start = after ? rows.findIndex((each) => each.threadId === after) + 1 : 0;
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  return { rows: page, next: start + limit < rows.length && last ? last.threadId : null };
}

/** A row as `--json` carries it: the state in words, not how a terminal draws it. */
function publicRow(row: ThreadRow) {
  const { icon: _icon, tone: _tone, ...rest } = row;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

/** `ace thread list --json`: the page's list entries in order, their rows, the next cursor. */
export function threadListJson(
  entries: readonly ThreadListEntry[],
  page: { rows: readonly ThreadRow[]; next: string | null },
  window: ThreadListWindow | undefined,
) {
  const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
  return {
    threads: page.rows.flatMap((row) => {
      const entry = byId.get(row.threadId);
      return entry ? [entry] : [];
    }),
    rows: page.rows.map(publicRow),
    next: page.next,
    ...(window ? { window } : {}),
  };
}
