import { z } from "zod";
import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import type { Arrangement, HomeSort } from "./arrange.ts";
import type { AttentionLevel } from "./row-attention.ts";
import { threadCard } from "./thread-card.ts";
import { activityOf } from "./thread-state.ts";

/*
 * The Threads panel as Inbox + Projects. The Inbox holds what needs the person: a request, an
 * unseen failure, finished work not yet opened. Running and Recent are places that open as a
 * focused list. Below them each project lists its other open threads (never one the Inbox
 * already shows), and projects with nothing open fold under Quiet projects. Every placement
 * reads the row attention every row draws (`threadCard` → `rowAttention`), so a group never
 * disagrees with the row's own status word, and a thread whose agent tree still works reads
 * as running, never as done. Pure: the caller passes the clock.
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

/** How far back Recent reaches. */
export const recentDays = 7;
const dayMs = 24 * 60 * 60 * 1000;

/** The first moment Recent covers on this clock. */
export function recentSince(now: number): number {
  return now - recentDays * dayMs;
}

/** A thread in Recent: when it finished, and whether it is settled. */
export interface RecentItem {
  id: string;
  at: number;
  settled: boolean;
}

export interface TreeProject {
  id: string;
  /** Its open threads the Inbox doesn't show, in the order the tree draws them. */
  threads: string[];
  /** Every open thread of the project, Inbox ones included: its focused Active tab. */
  open: string[];
  /** How many of its threads are running. */
  running: number;
  /** How many of its threads are in the Inbox. */
  inbox: number;
  /** Its loaded settled threads, newest first. */
  settled: string[];
  /** Its settled threads in all, loaded or not. */
  settledTotal: number;
}

export interface HomeTree {
  inbox: string[];
  running: string[];
  recent: RecentItem[];
  /** Projects with open threads, most recent activity first. */
  projects: TreeProject[];
  /** Projects with only settled threads, most recent activity first. */
  quiet: TreeProject[];
  /** Every open thread as the tree lists them: the Inbox, then each project's. */
  order: string[];
}

export interface TreeInput {
  arrangement: Arrangement;
  entry(id: string): ThreadListEntry | undefined;
  standing(entry: ThreadListEntry): Standing;
  sortBy: HomeSort;
  now: number;
  /**
   * The daemon's count of settled threads per project, while it still holds some back. A
   * project known only from it (nothing loaded) is quiet.
   */
  settledCounts?: ReadonlyMap<string, number> | undefined;
}

interface Building {
  open: string[];
  threads: string[];
  running: string[];
  inbox: number;
  settled: string[];
  activity: number;
}

/**
 * The tree from Home order (`arrange`): pinned threads lead each project; sorted by live
 * activity, running threads come next and the rest by recency, while Newest first and Manual
 * keep their own order below the pinned ones.
 */
export function homeTree(input: TreeInput): HomeTree {
  const { arrangement, entry, standing } = input;
  const since = recentSince(input.now);
  const projects = new Map<string, Building>();
  const project = (id: string): Building => {
    let known = projects.get(id);
    if (!known) {
      known = { open: [], threads: [], running: [], inbox: 0, settled: [], activity: 0 };
      projects.set(id, known);
    }
    return known;
  };
  const inbox: string[] = [];
  const running: string[] = [];
  const recent: RecentItem[] = [];
  for (const id of [...arrangement.pinned, ...arrangement.active, ...arrangement.recent]) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    const at = activityOf(shown);
    const place = project(shown.workspaceId);
    place.activity = Math.max(place.activity, at);
    place.open.push(id);
    if (inInbox(stands)) {
      inbox.push(id);
      place.inbox += 1;
      continue;
    }
    if (atWork(stands)) {
      running.push(id);
      place.running.push(id);
    }
    if (stands.done && stands.level === "quiet" && at >= since)
      recent.push({ id, at, settled: false });
    place.threads.push(id);
  }
  for (const id of arrangement.settled) {
    const shown = entry(id);
    if (!shown) continue;
    const at = activityOf(shown);
    const place = project(shown.workspaceId);
    place.activity = Math.max(place.activity, at);
    place.settled.push(id);
    const stands = standing(shown);
    // Settled yet still at work or asking (a tree still busy): not finished, so not Recent.
    if (at >= since && !atWork(stands) && stands.level !== "needs-you")
      recent.push({ id, at, settled: true });
  }
  for (const [id, count] of input.settledCounts ?? []) if (count > 0) project(id);
  const pinned = new Set(arrangement.pinned);
  const tree: TreeProject[] = [...projects].map(([id, place]) => {
    const lifted = new Set(input.sortBy === "activity" ? place.running : []);
    const rank = (thread: string) => (pinned.has(thread) ? 0 : lifted.has(thread) ? 1 : 2);
    // Sorting is stable: each rank keeps Home order.
    const threads = place.threads.toSorted((a, b) => rank(a) - rank(b));
    return {
      id,
      threads,
      open: place.open.toSorted((a, b) => rank(a) - rank(b)),
      running: place.running.length,
      inbox: place.inbox,
      settled: place.settled,
      settledTotal: Math.max(place.settled.length, input.settledCounts?.get(id) ?? 0),
    };
  });
  const activity = (id: string) => projects.get(id)?.activity ?? 0;
  const byActivity = (a: TreeProject, b: TreeProject) =>
    activity(b.id) - activity(a.id) || a.id.localeCompare(b.id);
  const busy = tree.filter((place) => place.open.length > 0).toSorted(byActivity);
  const quiet = tree
    .filter((place) => place.open.length === 0 && place.settledTotal > 0)
    .toSorted(byActivity);
  recent.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return {
    inbox,
    running,
    recent,
    projects: busy,
    quiet,
    order: [...inbox, ...busy.flatMap((place) => place.threads)],
  };
}

/** Local midnight at the start of `at`'s day. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Recent's day groups, newest first. */
export type RecentGroup = "today" | "yesterday" | "week";
export const recentGroupLabels: Record<RecentGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Earlier this week",
};

/** Which of Recent's groups a thread that finished at `at` falls in. */
export function recentGroupOf(at: number, now: number): RecentGroup {
  const today = startOfDay(now);
  if (at >= today) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return at >= yesterday.getTime() ? "yesterday" : "week";
}

/** A focused list inside the panel: a place, or one project on its Active or Settled tab. */
export const HomeFocus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox") }),
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("recent") }),
  z.object({
    kind: z.literal("project"),
    id: z.string().min(1).max(4096),
    tab: z.enum(["active", "settled"]).catch("active"),
  }),
]);
export type HomeFocus = z.infer<typeof HomeFocus>;
