/*
 * Transcript order is the daemon's creation sequence (the seq of an item's first upsert), and
 * nothing else: wall-clock `createdAt` is for display only. Events arrive in sequence order, so a
 * live item is appended; history and windows are merged by sequence.
 */

/**
 * Two id lists, each oldest first, merged by creation sequence. An `older` id without a known
 * sequence stays ahead of `newer`; a `newer` id without one stays behind `older`.
 */
export function mergeBySeq(
  older: readonly string[],
  newer: readonly string[],
  seq: (id: string) => number | undefined,
): string[] {
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  while (i < older.length && j < newer.length) {
    const a = older[i] ?? "";
    const b = newer[j] ?? "";
    if ((seq(a) ?? -Infinity) < (seq(b) ?? Infinity)) {
      merged.push(a);
      i++;
    } else {
      merged.push(b);
      j++;
    }
  }
  for (; i < older.length; i++) merged.push(older[i] ?? "");
  for (; j < newer.length; j++) merged.push(newer[j] ?? "");
  return merged;
}

/** One held item, given oldest first in creation order. */
export interface TailEntry {
  id: string;
  seq: number | undefined;
  /** The item belongs to the thread's root agent. */
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
 * Which items a bounded transcript tail keeps (ADR 0006, ADR 0062): the newest `capacity`, except
 * that the root agent's own items keep at least half of it, so busy subagents cannot push the
 * person's prompts and the root's replies out of the root transcript. Root items and other
 * agents' items are each kept as their newest run, so each stays contiguous. The daemon's
 * snapshot and the client's trim both choose with this rule, so a resnapshot holds what live
 * delivery held.
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
