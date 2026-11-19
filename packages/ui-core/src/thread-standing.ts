import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import type { AttentionLevel } from "./row-attention.ts";
import { threadCard } from "./thread-card.ts";
import { isSettled } from "./thread-state.ts";

/*
 * How a listed thread stands, read from the row attention every row draws (`threadCard` →
 * `rowAttention`), so whatever reads it (the daemon's placement, the Chats panel, the rail's
 * dot) never disagrees with the row's own status word. Pure: the caller passes the clock.
 */

export interface Standing {
  level: AttentionLevel;
  /** Its status is done (finished work), whatever the person has seen. */
  done: boolean;
  /**
   * Nothing works for it right now: it is held at a usage limit, or only a command it left
   * running is still going. A settled thread held this way stays settled.
   */
  held: boolean;
}

export interface StandingInput {
  /** Activity before this moment counts as seen (a first launch's baseline). */
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
  const { status } = entry;
  const held =
    status.state === "limited" ||
    (status.state === "waiting" && (status.on === "background_task" || status.on === "rate_limit"));
  return { level: card.attention.level, done: status.state === "done", held };
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

/**
 * A settled thread that stays settled: nothing asks the person, and its tree doesn't work or is
 * only held (a usage limit, a command left running), which is not work they settled it away from.
 */
export function atRest(standing: Standing): boolean {
  return standing.level !== "needs-you" && (!atWork(standing) || standing.held);
}

/**
 * A chat the Chats panel lists among its active chats (ADR 0099): every one it lists that isn't
 * settled and at rest, snoozed or not (it has no Snoozed place). Its list and its rail dot read
 * this one rule.
 */
export function chatActive(entry: ThreadListEntry, standing: Standing): boolean {
  return !(isSettled(entry) && atRest(standing));
}
