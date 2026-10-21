import type { Item, ItemsWindowResponse } from "@ace/protocol";
import { laneBefore } from "@ace/projection";
import { isPersonMessage } from "./person-message.ts";

/*
 * The history window (ADR 0062): besides the live tail it leases, a thread view holds at most
 * one window of history, contiguous in creation order for the transcript it shows. A jump
 * replaces it; reading older or newer grows it by whole turns up to a bound and trims it only
 * at the end away from where the reader is reading, so nothing the reader sees ever leaves.
 * Where it meets the tail the two are one run, merged by creation sequence. Pure.
 */

/** Items a window may hold (ADR 0056): a few thousand, far more than any screen shows. */
export const windowCapacity = 2_000;
/** Estimated UTF-16 units of text a window may hold besides its item count (ADR 0056). */
export const windowWeight = 8 * 1024 * 1024;
/** Items read per older or newer request: the most `items.window` returns besides its target. */
export const slideSize = 199;

export interface JumpWindow {
  /** Oldest first, contiguous in creation order for the window's transcript. */
  readonly items: readonly Item[];
  /** Creation sequence of each item. */
  readonly seqs: ReadonlyMap<string, number>;
  /**
   * Exclusive cursor for older items: the transcript may be missing items before it (the
   * first item's sequence, or older); null at the thread's start.
   */
  readonly before: number | null;
  /** Exclusive cursor for newer items (the last item's sequence), null at the thread's end. */
  readonly after: number | null;
  /** The item the jump aimed at (a turn's first item, a search hit). */
  readonly targetId: string | undefined;
}

/** How much a window may hold: an item count and an estimate of its text. */
export interface WindowBounds {
  capacity: number;
  weight: number;
}
export const windowBounds: WindowBounds = { capacity: windowCapacity, weight: windowWeight };

type WindowReply = Pick<
  ItemsWindowResponse,
  "items" | "itemSeqs" | "itemsBefore" | "itemsAfter" | "targetSeq"
>;

/** A window from a jump's reply; the target is the item at the reply's `targetSeq`. */
export function openWindow(reply: WindowReply): JumpWindow {
  const seqs = new Map<string, number>();
  for (const item of reply.items) {
    const seq = reply.itemSeqs[item.id];
    if (seq !== undefined) seqs.set(item.id, seq);
  }
  const items = reply.items.filter((item) => seqs.has(item.id));
  const target =
    reply.targetSeq === null
      ? undefined
      : items.find((item) => seqs.get(item.id) === reply.targetSeq)?.id;
  return {
    items,
    seqs,
    before: reply.itemsBefore,
    after: reply.itemsAfter,
    targetId: target ?? items[0]?.id,
  };
}

/**
 * The request for older items: whole turns before the window's older cursor (its first item
 * is the reply's target, so the two overlap and nothing between them is skipped).
 */
export function olderRequest(
  window: JumpWindow,
  size = slideSize,
): { aroundSeq: number; before: number; after: 0; wholeTurns: true } | undefined {
  return window.before === null
    ? undefined
    : { aroundSeq: window.before, before: size, after: 0, wholeTurns: true };
}

/**
 * The request for newer items: up to `size` after the window's last item. A live thread keeps
 * growing, so there is always a next request, even when the window ended at the thread's end.
 */
export function newerRequest(
  window: JumpWindow,
  size = slideSize,
): { aroundSeq: number; before: 0; after: number } | undefined {
  const last = window.items.at(-1);
  const seq = last ? window.seqs.get(last.id) : window.after;
  return seq === undefined || seq === null
    ? undefined
    : { aroundSeq: seq + 1, before: 0, after: Math.max(0, size - 1) };
}

/** A cheap estimate of the text an item holds, in UTF-16 units; other fields are bounded. */
export function itemWeight(item: Item): number {
  let text = 0;
  if (item.type === "message")
    for (const part of item.parts) text += part.type === "text" ? part.text.length : 256;
  else if (item.type === "reasoning" || item.type === "notice") text = item.text.length;
  return text + 1024;
}

/** Whether a person's message starts a turn here: where older history may be cut. */
const startsTurn = (item: Item | undefined) => isPersonMessage(item);

function merged(window: JumpWindow, reply: WindowReply) {
  const seqs = new Map(window.seqs);
  const byId = new Map(window.items.map((item) => [item.id, item]));
  for (const item of reply.items) {
    const seq = reply.itemSeqs[item.id];
    if (seq === undefined) continue;
    seqs.set(item.id, seq);
    byId.set(item.id, item);
  }
  const items = [...byId.values()].toSorted(
    (a, b) => (seqs.get(a.id) ?? 0) - (seqs.get(b.id) ?? 0),
  );
  return { items, seqs };
}

function bounded(
  items: readonly Item[],
  seqs: ReadonlyMap<string, number>,
  edges: { before: number | null; after: number | null },
  targetId: string | undefined,
): JumpWindow {
  const kept = new Map<string, number>();
  for (const item of items) kept.set(item.id, seqs.get(item.id) ?? 0);
  return { items, seqs: kept, ...edges, targetId };
}

/** How many of `items`, counted from the given end, fit the bounds. */
function fitting(items: readonly Item[], bounds: WindowBounds, fromNewest: boolean): number {
  let weight = 0;
  let count = 0;
  for (let at = 0; at < items.length && count < bounds.capacity; at++) {
    const item = items[fromNewest ? items.length - 1 - at : at];
    if (!item) break;
    weight += itemWeight(item);
    if (count > 0 && weight > bounds.weight) break;
    count++;
  }
  return count;
}

/**
 * The window with older items added in front. The reader is reading at its older end, so
 * items beyond the bounds leave from the newer end, which then has a cursor again.
 */
export function withOlder(
  window: JumpWindow,
  reply: WindowReply,
  bounds: WindowBounds = windowBounds,
): JumpWindow {
  const { items, seqs } = merged(window, reply);
  const kept = items.slice(0, fitting(items, bounds, false));
  const trimmed = kept.length < items.length;
  const first = kept[0];
  const last = kept.at(-1);
  // The reply's own older cursor applies only if its first item is the window's first.
  const before =
    first && reply.items[0]?.id === first.id
      ? reply.itemsBefore
      : first
        ? first.id === window.items[0]?.id
          ? window.before
          : (seqs.get(first.id) ?? null)
        : window.before;
  const after = trimmed && last ? (seqs.get(last.id) ?? window.after) : window.after;
  return bounded(kept, seqs, { before, after }, window.targetId);
}

/**
 * The window with newer items added behind. The reader is reading at its newer end, so items
 * beyond the bounds leave from the older end, in whole turns where a turn start is near: the
 * window's first item then starts a turn, and its older cursor is that item.
 */
export function withNewer(
  window: JumpWindow,
  reply: WindowReply,
  bounds: WindowBounds = windowBounds,
): JumpWindow {
  const { items, seqs } = merged(window, reply);
  let from = items.length - fitting(items, bounds, true);
  if (from > 0) {
    // A turn start shortly after the cut moves it there; a giant turn is cut by the bounds.
    const turn = items.findIndex((item, index) => index >= from && startsTurn(item));
    if (turn >= 0 && turn - from <= slideSize && turn < items.length - 1) from = turn;
  }
  const kept = items.slice(from);
  const trimmed = from > 0;
  const first = kept[0];
  const last = kept.at(-1);
  const after =
    last && reply.items.at(-1)?.id === last.id
      ? reply.itemsAfter
      : last && last.id === window.items.at(-1)?.id
        ? window.after
        : last
          ? (seqs.get(last.id) ?? null)
          : window.after;
  const before = trimmed && first ? (seqs.get(first.id) ?? window.before) : window.before;
  return bounded(kept, seqs, { before, after }, window.targetId);
}

/** What a thread's live tail holds, as a window meets it. */
export interface TailEdge {
  order: readonly string[];
  /** Every tail item at or after this sequence is held; null when it holds the whole thread. */
  before: number | null | undefined;
  /** A tail item's creation sequence. */
  seq?(id: string): number | undefined;
  /**
   * Whether a tail item reads in the window's transcript. The tail keeps each transcript lane
   * as its own newest run, so a lane may reach back past `before`.
   */
  inLane?(id: string): boolean;
}

/** Where the tail holds the window's transcript from (`laneBefore`). */
export function tailLaneBefore(tail: TailEdge): number | null | undefined {
  const { seq, inLane } = tail;
  return seq && inLane ? laneBefore(tail.order, seq, inLane, tail.before) : tail.before;
}

/**
 * Whether the window meets the live tail, so the two are one run with no hole between them:
 * the window reaches the item before where the tail holds its transcript from, or the tail
 * holds the whole thread. Without sequences, a shared item decides.
 */
export function meetsTail(window: JumpWindow, tail: TailEdge): boolean {
  const from = tailLaneBefore(tail);
  if (from === null) return true;
  const last = window.items.at(-1);
  const lastSeq = last ? window.seqs.get(last.id) : undefined;
  if (typeof from === "number" && lastSeq !== undefined) return lastSeq >= from - 1;
  const ids = new Set(tail.order);
  return window.items.some((item) => ids.has(item.id));
}

/** Whether the window holds this item. */
export function windowHas(window: JumpWindow, itemId: string): boolean {
  return window.seqs.has(itemId);
}

/**
 * Each window item's root turn, from where turns start (`turns.page` summaries): the latest
 * turn that started at or before the item's sequence. Items older than every known start are
 * left out. A window's items may outlive the client's runs, so this is how a jumped window
 * knows its turns.
 */
export function windowTurnOrdinals(
  window: JumpWindow,
  starts: Iterable<{ ordinal: number; startSeq: number }>,
): Map<string, number> {
  const sorted = [...starts].toSorted((a, b) => a.startSeq - b.startSeq);
  const ordinals = new Map<string, number>();
  let at = -1;
  for (const item of window.items) {
    const seq = window.seqs.get(item.id);
    if (seq === undefined) continue;
    while (at + 1 < sorted.length && (sorted[at + 1]?.startSeq ?? Infinity) <= seq) at++;
    const turn = sorted[at];
    if (turn) ordinals.set(item.id, turn.ordinal);
  }
  return ordinals;
}
