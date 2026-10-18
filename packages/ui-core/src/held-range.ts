import type { Item } from "@ace/protocol";
import {
  itemWeight,
  meetsTail,
  tailLaneBefore,
  windowBounds,
  type JumpWindow,
  type TailEdge,
  type WindowBounds,
} from "./jump-window.ts";

/*
 * Holding what the reader sees (ADR 0062). The live tail is bounded and shared by every view of
 * the thread, so it trims its oldest items as new ones arrive, whoever is reading them. A view
 * whose reader leaves the live end holds its rows as a window instead: the window keeps every
 * row it was given, takes the tail's new rows before the tail can trim past it, and stops at
 * its bounds by leaving the live end behind a gap, never by dropping what the reader reads.
 * Pure.
 */

/** A live tail a window can take items from. */
export interface HeldTail extends TailEdge {
  seq(id: string): number | undefined;
  inLane(id: string): boolean;
  item(id: string): Item | undefined;
}

/**
 * The window's lane items the tail still holds at or before the window's end. When the tail
 * has trimmed this many more, it would trim past the window: the window takes the tail's newer
 * items before then.
 */
export const absorbMargin = 50;

/**
 * A window of what the tail holds of the transcript now: every tail item from where the tail
 * holds the transcript from, so the window is one run that meets the tail. Undefined when the
 * tail shows nothing of the transcript yet.
 */
export function holdTail(tail: HeldTail): JumpWindow | undefined {
  const from = tailLaneBefore(tail);
  if (from === undefined) return undefined;
  const items: Item[] = [];
  const seqs = new Map<string, number>();
  let shown = false;
  for (const id of tail.order) {
    const seq = tail.seq(id);
    const item = tail.item(id);
    if (seq === undefined || !item || (from !== null && seq < from)) continue;
    items.push(item);
    seqs.set(id, seq);
    if (tail.inLane(id)) shown = true;
  }
  const last = items.at(-1);
  if (!shown || !last) return undefined;
  return { items, seqs, before: from, after: seqs.get(last.id) ?? null, targetId: undefined };
}

export interface Absorbed {
  window: JumpWindow;
  /** The window still meets the tail. */
  joined: boolean;
}

/**
 * The window after the tail moved. While it meets the tail the tail's items show through it
 * live; once the tail is about to trim past the window's end (`absorbMargin`), the window takes
 * the tail's newer lane items itself. Past its bounds it stops: by default it leaves the tail
 * behind (a gap after its end), keeping every row it holds; `trimOlder`, for a reader reading
 * at the window's newer end, drops its oldest items instead and stays joined.
 */
export function absorbTail(
  window: JumpWindow,
  tail: HeldTail,
  options: { bounds?: WindowBounds; trimOlder?: boolean } = {},
): Absorbed {
  if (!meetsTail(window, tail)) return { window, joined: false };
  const last = window.items.at(-1);
  const lastSeq = last ? window.seqs.get(last.id) : undefined;
  if (lastSeq === undefined) return { window, joined: true };
  let held = 0;
  const newer: Item[] = [];
  const seqs = new Map(window.seqs);
  for (const id of tail.order) {
    if (!tail.inLane(id)) continue;
    const seq = tail.seq(id);
    if (seq === undefined) continue;
    if (seq <= lastSeq) {
      held++;
      continue;
    }
    const item = tail.item(id);
    if (!item) continue;
    newer.push(item);
    seqs.set(id, seq);
  }
  // Far from the tail's trimming edge, or little to take: the tail shows its items itself.
  if (held > absorbMargin || newer.length < Math.ceil(absorbMargin / 2))
    return { window, joined: true };
  const bounds = options.bounds ?? windowBounds;
  let items = [...window.items, ...newer];
  let weight = 0;
  for (const item of items) weight += itemWeight(item);
  let from = 0;
  if (options.trimOlder)
    while (
      items.length - from > 1 &&
      (items.length - from > bounds.capacity || weight > bounds.weight)
    ) {
      const first = items[from];
      if (first) weight -= itemWeight(first);
      from++;
    }
  else {
    let end = items.length;
    while (end > window.items.length && (end > bounds.capacity || weight > bounds.weight)) {
      const dropped = items[end - 1];
      if (dropped) weight -= itemWeight(dropped);
      end--;
    }
    items = items.slice(0, end);
  }
  items = items.slice(from);
  const took = items.at(-1)?.id === newer.at(-1)?.id;
  const kept = new Map<string, number>();
  for (const item of items) kept.set(item.id, seqs.get(item.id) ?? 0);
  const first = items[0];
  const end = items.at(-1);
  return {
    window: {
      items,
      seqs: kept,
      before: from > 0 && first ? (kept.get(first.id) ?? window.before) : window.before,
      after: end ? (kept.get(end.id) ?? window.after) : window.after,
      targetId: window.targetId,
    },
    joined: took,
  };
}
