import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import type { Arrangement, HomeSort } from "./arrange.ts";
import type { AttentionLevel } from "./row-attention.ts";
import { threadCard } from "./thread-card.ts";
import { activityOf, isSettled } from "./thread-state.ts";

/*
 * The Threads panel (ADR 0107): Active on top, then Projects. Active is one flat list of every
 * unsettled thread across projects and machines: pinned ones first in their own order, then what
 * needs the person (a request, an unseen failure), then what is at work (its agent tree, waits
 * and background commands included), then the rest. Each project below holds only its settled
 * threads, newest first; projects with no thread at all are quiet. Every placement reads the row
 * attention every row draws (`threadCard` → `rowAttention`), so a group never disagrees with the
 * row's own status word, and a thread whose agent tree still works or asks is Active, never in a
 * project's settled threads. Pure: the caller passes the clock.
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

/** Needs the person: a request (approval, question, plan) or a failure they haven't seen. */
export function needsPerson(standing: Standing): boolean {
  return standing.level === "needs-you" || standing.level === "failed";
}

/** At work: working, background commands, waiting, its whole agent tree included. */
export function atWork(standing: Standing): boolean {
  return standing.level === "active";
}

/** A settled thread at rest: its tree neither works nor asks, so it belongs in its project. */
export function atRest(standing: Standing): boolean {
  return !atWork(standing) && standing.level !== "needs-you";
}

export interface TreeProject {
  id: string;
  /** Its settled threads at rest that are loaded, newest first. */
  settled: string[];
  /** How many of its threads are in Active. */
  active: number;
  /** How many more settled threads the daemon holds back for it: History has them. */
  held: number;
}

export interface HomeTree {
  /**
   * Every unsettled thread across projects: pinned first, then (sorted by live activity) what
   * needs the person, then what is at work, then the rest, each group in Home order.
   */
  active: string[];
  /** Projects with any thread, most recent activity first. */
  projects: TreeProject[];
  /** Projects with no thread at all, by name order as given. */
  quiet: string[];
  /** Every thread the tree lists, top to bottom: Active, then each project's settled ones. */
  order: string[];
  /** Settled threads at rest that are loaded, most recent activity first: History's own. */
  settled: string[];
}

export interface TreeInput {
  arrangement: Arrangement;
  entry(id: string): ThreadListEntry | undefined;
  standing(entry: ThreadListEntry): Standing;
  /**
   * How Home sorts (`threads.sortBy`). By live activity, Active groups what needs the person,
   * then what is at work, then the rest; Newest first and Manual keep their own order.
   */
  sortBy?: HomeSort | undefined;
  /**
   * The daemon's count of settled threads per project it still holds back. A project known
   * only from it (nothing loaded) is listed, its threads in History.
   */
  settledCounts?: ReadonlyMap<string, number> | undefined;
  /** Every project the person has: those with no thread at all are quiet. */
  projects?: readonly string[] | undefined;
}

/**
 * The tree from Home order (`arrange`). A settled thread whose tree still works or asks is not
 * at rest: it is Active until it rests again.
 */
export function homeTree(input: TreeInput): HomeTree {
  const { arrangement, entry, standing } = input;
  const activity = new Map<string, number>();
  const counts = new Map<string, { active: number; settled: string[] }>();
  const project = (id: string) => {
    let known = counts.get(id);
    if (!known) {
      known = { active: 0, settled: [] };
      counts.set(id, known);
    }
    return known;
  };
  const touch = (shown: ThreadListEntry) =>
    activity.set(
      shown.workspaceId,
      Math.max(activity.get(shown.workspaceId) ?? 0, activityOf(shown)),
    );
  const groups: [string[], string[], string[], string[]] = [[], [], [], []];
  const pinned = new Set(arrangement.pinned);
  const byActivity = (input.sortBy ?? "activity") === "activity";
  const settled: string[] = [];
  const placeActive = (id: string, shown: ThreadListEntry, stands: Standing) => {
    touch(shown);
    project(shown.workspaceId).active += 1;
    const group = pinned.has(id)
      ? 0
      : !byActivity
        ? 3
        : needsPerson(stands)
          ? 1
          : atWork(stands)
            ? 2
            : 3;
    groups[group].push(id);
  };
  for (const id of [...arrangement.pinned, ...arrangement.active, ...arrangement.recent]) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    // A pinned thread the person settled rests in its project, unless its tree still works.
    if (pinned.has(id) && isSettled(shown) && atRest(stands)) {
      touch(shown);
      settled.push(id);
      project(shown.workspaceId).settled.push(id);
      continue;
    }
    placeActive(id, shown, stands);
  }
  for (const id of arrangement.settled) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    // Settled yet its tree still works or asks: Active, never in its project, never in History.
    if (!atRest(stands)) {
      placeActive(id, shown, stands);
      continue;
    }
    touch(shown);
    settled.push(id);
    project(shown.workspaceId).settled.push(id);
  }
  const held = input.settledCounts ?? new Map<string, number>();
  for (const [id, count] of held) if (count > 0) project(id);
  const at = (id: string) => {
    const shown = entry(id);
    return shown ? activityOf(shown) : 0;
  };
  const newest = (ids: string[]) => ids.toSorted((a, b) => at(b) - at(a) || a.localeCompare(b));
  const projects: TreeProject[] = [...counts]
    .map(([id, place]) => ({
      id,
      settled: newest(place.settled),
      active: place.active,
      held: held.get(id) ?? 0,
    }))
    .toSorted(
      (a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || a.id.localeCompare(b.id),
    );
  const active = groups.flat();
  return {
    active,
    projects,
    quiet: (input.projects ?? []).filter((id) => !counts.has(id)),
    order: [...active, ...projects.flatMap((place) => place.settled)],
    settled: newest(settled),
  };
}
