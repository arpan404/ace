import { inRootLane, laneBefore } from "@ace/projection";

/*
 * Resuming, not replacing (ADR 0062): when the daemon answers a resubscription with a snapshot,
 * the transcript the client already holds is kept wherever it meets the snapshot without a
 * hole. Each lane (the root transcript's items, and every other agent's) is complete from its
 * own cursor, so each lane is joined on its own. Pure.
 */

/** One side of the merge: ids oldest first, by creation sequence. */
export interface TranscriptSide {
  order: readonly string[];
  seq(id: string): number | undefined;
  agentOf(id: string): string | undefined;
  /** Whether the item is finished (no longer streaming or running). */
  complete(id: string): boolean;
  /** Every item at or after this is held; null when held back to the thread's start. */
  before: number | null | undefined;
}

export interface Resumed {
  /** Held items older than the snapshot that stay, oldest first. */
  kept: string[];
  /** The joined transcript's cursor: every item at or after it is held. */
  before: number | null;
}

/**
 * What a held transcript (complete up to `cursor`) keeps when a snapshot arrives. A lane keeps
 * its older items only when the snapshot's part of that lane starts at or before the held
 * cursor, so the two meet; held items the snapshot's range covers are the snapshot's to say
 * (an absent one was deleted). Events the gap skipped may have changed an older item that was
 * still running, so a lane keeps only the finished items after its newest unfinished one: what
 * it keeps cannot be stale (bar a rare edit to a finished item). Undefined when nothing older
 * survives, or when sequences are missing (never on the wire): the snapshot then replaces what
 * was held.
 */
export function resumeTranscript(
  held: TranscriptSide,
  cursor: number,
  incoming: TranscriptSide,
  rootAgentId: string | undefined,
): Resumed | undefined {
  const kept: string[] = [];
  let joined: number | null = null;
  let any = false;
  for (const root of [true, false]) {
    const inLane = (side: TranscriptSide) => (id: string) =>
      inRootLane(side.agentOf(id), rootAgentId) === root;
    const from = laneBefore(incoming.order, incoming.seq, inLane(incoming), incoming.before);
    // The snapshot holds this lane whole: nothing older to keep.
    if (from === null || from === undefined) continue;
    const heldFrom = laneBefore(held.order, held.seq, inLane(held), held.before);
    const meets = from <= cursor + 1 && heldFrom !== undefined;
    let lane = from;
    if (meets) {
      const own = inLane(held);
      let run: string[] = [];
      let whole = true;
      for (const id of held.order) {
        if (!own(id)) continue;
        const seq = held.seq(id);
        if (seq === undefined) return undefined;
        if (seq >= from) break;
        if (held.complete(id)) run.push(id);
        else {
          run = [];
          whole = false;
        }
      }
      kept.push(...run);
      const first = run[0];
      if (whole) {
        // Held back to the thread's start: this lane is whole.
        if (heldFrom === null) continue;
        lane = Math.min(heldFrom, from);
      } else if (first !== undefined) lane = Math.min(held.seq(first) ?? from, from);
    }
    any = true;
    joined = joined === null ? lane : Math.max(joined, lane);
  }
  if (!kept.length) return undefined;
  kept.sort((a, b) => (held.seq(a) ?? 0) - (held.seq(b) ?? 0));
  return { kept, before: any ? joined : null };
}
