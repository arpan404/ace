/*
 * Transcript order is the daemon's creation sequence (the seq of an item's first upsert), and
 * nothing else: wall-clock `createdAt` is for display only. Events arrive in sequence order, so a
 * live item is appended; history, windows and snapshots are merged by sequence. An item whose
 * sequence is unknown has no place in a transcript: that is a protocol error, never an edge.
 */

/** The creation sequence of an item every holder must know. */
export class MissingSequenceError extends Error {
  readonly itemId: string;
  constructor(itemId: string) {
    super(`Item ${itemId} has no creation sequence`);
    this.name = "MissingSequenceError";
    this.itemId = itemId;
  }
}

/**
 * Two id lists, each oldest first, merged by creation sequence; an id in both is kept once.
 * Work is proportional to the two lists. Throws `MissingSequenceError` for an id without one.
 */
export function mergeBySeq(
  older: readonly string[],
  newer: readonly string[],
  seq: (id: string) => number | undefined,
): string[] {
  const of = (id: string) => {
    const value = seq(id);
    if (value === undefined) throw new MissingSequenceError(id);
    return value;
  };
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  let last: string | undefined;
  const push = (id: string) => {
    if (id !== last) merged.push(id);
    last = id;
  };
  while (i < older.length && j < newer.length) {
    const a = older[i] ?? "";
    const b = newer[j] ?? "";
    const sa = of(a);
    const sb = of(b);
    if (sa <= sb) {
      push(a);
      i++;
      if (sa === sb && a === b) j++;
    } else {
      push(b);
      j++;
    }
  }
  for (; i < older.length; i++) push(older[i] ?? "");
  for (; j < newer.length; j++) push(newer[j] ?? "");
  return merged;
}

/**
 * The transcript an item reads in: the root agent's, which also carries the thread's own items
 * (no agent: a device recording, say), or one subagent's. A root transcript renders its lane, so
 * it needs its lane complete, not the whole thread.
 */
export function inRootLane(agentId: string | undefined, rootAgentId: string | undefined): boolean {
  return !agentId || agentId === rootAgentId;
}

/**
 * The exclusive cursor before which one lane may be missing items, for a holder that keeps
 * every item at or after `before` and, per lane, one newest run (`retainedTail`). Its lane is
 * complete from its oldest held item; null when the holder reaches the thread's start.
 */
export function laneBefore(
  order: readonly string[],
  seq: (id: string) => number | undefined,
  inLane: (id: string) => boolean,
  before: number | null | undefined,
): number | null | undefined {
  if (before === null || before === undefined) return before;
  for (const id of order) {
    if (!inLane(id)) continue;
    const value = seq(id);
    return value === undefined ? before : Math.min(value, before);
  }
  return before;
}

/** One held item, given oldest first in creation order. */
export interface TailEntry {
  id: string;
  seq: number | undefined;
  /** The item reads in the root transcript (`inRootLane`). */
  root: boolean;
}

export interface RetainedTail {
  kept: TailEntry[];
  evicted: TailEntry[];
  /**
   * Exclusive cursor before which items may be missing: the first kept item after the newest
   * evicted one. Every item at or after it is kept. Undefined when nothing was evicted.
   */
  before: number | undefined;
}

/**
 * Which items a bounded live tail keeps (ADR 0006, ADR 0062): the newest `capacity`, except
 * that the root lane keeps at least half of it, so busy subagents cannot push the person's
 * prompts and the root's replies out of the root transcript. Each lane (root, and every other
 * agent's together) is kept as its newest run, so each stays contiguous from its oldest kept
 * item: `laneBefore` names where each lane is complete from. The daemon's snapshot and the
 * client's trim both choose with this rule, so a resnapshot holds what live delivery held.
 */
export function retainedTail(entries: readonly TailEntry[], capacity: number): RetainedTail {
  if (entries.length <= capacity) return { kept: [...entries], evicted: [], before: undefined };
  const reserve = Math.floor(capacity / 2);
  let roots = 0;
  let recentRoots = 0;
  const recentStart = entries.length - capacity;
  for (let index = 0; index < entries.length; index++)
    if (entries[index]?.root) {
      roots++;
      if (index >= recentStart) recentRoots++;
    }
  let keepRoots = Math.max(recentRoots, Math.min(roots, reserve));
  let keepOthers = capacity - keepRoots;
  const keep = Array.from({ length: entries.length }, () => false);
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.root ? keepRoots-- > 0 : keepOthers-- > 0) keep[index] = true;
  }
  const kept: TailEntry[] = [];
  const evicted: TailEntry[] = [];
  let newestEvicted = -1;
  entries.forEach((entry, index) => {
    if (keep[index]) kept.push(entry);
    else {
      evicted.push(entry);
      newestEvicted = index;
    }
  });
  const boundary = entries.slice(newestEvicted + 1).find((entry) => entry.seq !== undefined);
  const last = entries[newestEvicted]?.seq;
  return {
    kept,
    evicted,
    before: boundary?.seq ?? (last === undefined ? undefined : last + 1),
  };
}
