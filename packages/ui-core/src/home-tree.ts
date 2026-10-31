import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import type { Arrangement, HomeSort } from "./arrange.ts";
import type { AttentionLevel } from "./row-attention.ts";
import { threadCard } from "./thread-card.ts";
import { activityOf } from "./thread-state.ts";

/*
 * The Threads panel as projects, with the Inbox beside them. The Inbox holds what needs the
 * person: a request, an unseen failure, finished work not yet opened. Each project lists its
 * other open threads (never one the Inbox shows), then the threads it settled within the grace
 * period the person chose; older settled threads are only in History. Projects with nothing
 * open or recent fold under Quiet projects. Every placement reads the row attention every row
 * draws (`threadCard` → `rowAttention`), so a group never disagrees with the row's own status
 * word, and a thread whose agent tree still works reads as running, never as done or settled.
 * Pure: the caller passes the clock.
 */

/** How a listed thread stands, from its row attention. */
export interface Standing {
  level: AttentionLevel;
  /** Its status is done (finished work), whatever the person has seen. */
  done: boolean;
}

export interface StandingInput {
  /** Activity before this moment counts as seen (the organizer's first-launch baseline). */
  baseline: number;
  now: number;
  models?: readonly CatalogModel[] | undefined;
}

/** A thread's standing, read as its row reads it. */
export function standingOf(entry: ThreadListEntry, input: StandingInput): Standing {
  const card = threadCard({
    entry,
    baseline: input.baseline,
    now: input.now,
    settled: false,
    models: input.models,
  });
  return { level: card.attention.level, done: entry.status.state === "done" };
}

/**
 * `standingOf` for one clock, catalog and baseline, worked out once per entry snapshot: entries
 * are replaced, never changed, so a list update re-reads only the threads that changed.
 */
export function standingReader(input: StandingInput): (entry: ThreadListEntry) => Standing {
  const known = new WeakMap<ThreadListEntry, Standing>();
  return (entry) => {
    let standing = known.get(entry);
    if (standing === undefined) {
      standing = standingOf(entry, input);
      known.set(entry, standing);
    }
    return standing;
  };
}

/** Needs the person: a request, an unseen failure, finished work they haven't opened. */
export function inInbox(standing: Standing): boolean {
  return (
    standing.level === "needs-you" ||
    standing.level === "failed" ||
    standing.level === "done-unread"
  );
}

/** At work: working, background commands, waiting, its whole agent tree included. */
export function atWork(standing: Standing): boolean {
  return standing.level === "active";
}

/** How long a settled thread stays in its project (`threads.keepSettledFor`). */
export type KeepSettled = "0d" | "1d" | "3d" | "7d";

/** The choices every client offers for `threads.keepSettledFor`. */
export const keepSettledChoices: readonly { value: KeepSettled; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
  { value: "0d", label: "Move to History right away" },
];

const dayMs = 24 * 60 * 60 * 1000;

/** The grace period in milliseconds; 0 sends a settled thread straight to History. */
export function keepSettledMs(keep: KeepSettled): number {
  return Number.parseInt(keep, 10) * dayMs;
}

/** When a thread settled: the daemon's mark, else its last activity. */
export function settledAtOf(entry: ThreadListEntry): number {
  return entry.settledAt ?? activityOf(entry);
}

/** Whether a settled thread is still within its grace period on this clock. */
export function inGrace(entry: ThreadListEntry, now: number, graceMs: number): boolean {
  return graceMs > 0 && now - settledAtOf(entry) < graceMs;
}

export interface TreeProject {
  id: string;
  /** Its open threads the Inbox doesn't show, in the order the tree draws them. */
  threads: string[];
  /** How many of its threads are running. */
  running: number;
  /** How many of its threads are in the Inbox. */
  inbox: number;
  /** Its threads settled within the grace period, most recent activity first. */
  recent: string[];
}

export interface HomeTree {
  /** What needs the person, newest first. */
  inbox: string[];
  /** Projects with open, waiting or recently settled threads, most recent activity first. */
  projects: TreeProject[];
  /** Projects with none of those, most recent activity first. */
  quiet: string[];
  /** Every open thread: the Inbox, then each project's. */
  order: string[];
  /** Settled threads at rest that are loaded, most recent activity first: History's own. */
  settled: string[];
}

export interface TreeInput {
  arrangement: Arrangement;
  entry(id: string): ThreadListEntry | undefined;
  standing(entry: ThreadListEntry): Standing;
  sortBy: HomeSort;
  now: number;
  /** How long a settled thread stays in its project (`keepSettledMs`). */
  graceMs: number;
  /**
   * The daemon's count of settled threads per project, while it still holds some back. A
   * project known only from it (nothing loaded) is quiet.
   */
  settledCounts?: ReadonlyMap<string, number> | undefined;
}

interface Building {
  threads: string[];
  running: string[];
  inbox: number;
  recent: string[];
  activity: number;
}

/**
 * The tree from Home order (`arrange`): pinned threads lead each project; sorted by live
 * activity, running threads come next and the rest by recency, while Newest first and Manual
 * keep their own order below the pinned ones. A settled thread whose tree still works or asks
 * is not at rest: it shows as open work (or in the Inbox) until it rests again.
 */
export function homeTree(input: TreeInput): HomeTree {
  const { arrangement, entry, standing } = input;
  const projects = new Map<string, Building>();
  const project = (id: string): Building => {
    let known = projects.get(id);
    if (!known) {
      known = { threads: [], running: [], inbox: 0, recent: [], activity: 0 };
      projects.set(id, known);
    }
    return known;
  };
  const inbox: { id: string; at: number }[] = [];
  const settled: string[] = [];
  const placeOpen = (id: string, shown: ThreadListEntry, stands: Standing) => {
    const at = activityOf(shown);
    const home = project(shown.workspaceId);
    home.activity = Math.max(home.activity, at);
    if (inInbox(stands)) {
      inbox.push({ id, at });
      home.inbox += 1;
      return;
    }
    if (atWork(stands)) home.running.push(id);
    home.threads.push(id);
  };
  for (const id of [...arrangement.pinned, ...arrangement.active, ...arrangement.recent]) {
    const shown = entry(id);
    if (shown) placeOpen(id, shown, standing(shown));
  }
  for (const id of arrangement.settled) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    // Settled yet its tree still works or asks: never dimmed, never in History.
    if (atWork(stands) || stands.level === "needs-you") {
      placeOpen(id, shown, stands);
      continue;
    }
    settled.push(id);
    const home = project(shown.workspaceId);
    home.activity = Math.max(home.activity, activityOf(shown));
    if (inGrace(shown, input.now, input.graceMs)) home.recent.push(id);
  }
  for (const [id, count] of input.settledCounts ?? []) if (count > 0) project(id);
  const pinned = new Set(arrangement.pinned);
  const tree: TreeProject[] = [...projects].map(([id, place]) => {
    const lifted = new Set(input.sortBy === "activity" ? place.running : []);
    const rank = (thread: string) => (pinned.has(thread) ? 0 : lifted.has(thread) ? 1 : 2);
    // Sorting is stable: each rank keeps Home order.
    return {
      id,
      threads: place.threads.toSorted((a, b) => rank(a) - rank(b)),
      running: place.running.length,
      inbox: place.inbox,
      recent: place.recent,
    };
  });
  const activity = (id: string) => projects.get(id)?.activity ?? 0;
  const byActivity = (a: TreeProject, b: TreeProject) =>
    activity(b.id) - activity(a.id) || a.id.localeCompare(b.id);
  const busy = (place: TreeProject) =>
    place.threads.length > 0 || place.inbox > 0 || place.recent.length > 0;
  const sorted = tree.toSorted(byActivity);
  const listed = sorted.filter(busy);
  const ids = inbox.toSorted((a, b) => b.at - a.at || a.id.localeCompare(b.id)).map((x) => x.id);
  return {
    inbox: ids,
    projects: listed,
    quiet: sorted.filter((place) => !busy(place)).map((place) => place.id),
    order: [...ids, ...listed.flatMap((place) => place.threads)],
    settled,
  };
}
