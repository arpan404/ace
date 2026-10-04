import type { Item, ItemsWindowResponse } from "@ace/protocol";

/*
 * The jumped window (ADR 0062): besides the live tail it leases, a thread view holds at most
 * one contiguous window of up to 200 items fetched around a turn or a sequence. A new jump
 * replaces it; paging slides it, never growing it; it is dropped as soon as it reaches the
 * tail, so the transcript only ever shows one contiguous run of items. Pure.
 */

/** Items a window may hold, as the daemon's `items.window` reply does. */
export const windowCapacity = 200;
/** Items fetched per slide, older or newer. */
export const slideSize = 100;

export interface JumpWindow {
  /** Oldest first, contiguous in creation order, at most `windowCapacity`. */
  readonly items: readonly Item[];
  /** Creation sequence of each item. */
  readonly seqs: ReadonlyMap<string, number>;
  /** Exclusive cursor for older items (the first item's sequence), null at the thread's start. */
  readonly before: number | null;
  /** Exclusive cursor for newer items (the last item's sequence), null at the thread's end. */
  readonly after: number | null;
  /** The item the jump aimed at (a turn's first item, a search hit). */
  readonly targetId: string | undefined;
}

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

/** The request for older items (the window's first item and up to `size` before it). */
export function olderRequest(
  window: JumpWindow,
  size = slideSize,
): { aroundSeq: number; before: number; after: 0 } | undefined {
  return window.before === null ? undefined : { aroundSeq: window.before, before: size, after: 0 };
}

/** The request for newer items: up to `size` after the window's last item. */
export function newerRequest(
  window: JumpWindow,
  size = slideSize,
): { aroundSeq: number; before: 0; after: number } | undefined {
  return window.after === null
    ? undefined
    : { aroundSeq: window.after + 1, before: 0, after: Math.max(0, size - 1) };
}

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

/**
 * The window with older items added in front. Items beyond capacity leave from the newer end,
 * which then has a cursor again.
 */
export function withOlder(window: JumpWindow, reply: WindowReply): JumpWindow {
  const { items, seqs } = merged(window, reply);
  const kept = items.slice(0, windowCapacity);
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
 * The window with newer items added behind. Items beyond capacity leave from the older end,
 * which then has a cursor again.
 */
export function withNewer(window: JumpWindow, reply: WindowReply): JumpWindow {
  const { items, seqs } = merged(window, reply);
  const kept = items.slice(Math.max(0, items.length - windowCapacity));
  const trimmed = kept.length < items.length;
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

/** What a thread's live tail holds: its item ids and the cursor before its oldest item. */
export interface TailEdge {
  order: readonly string[];
  /** The tail's oldest item's sequence; null when it reaches back to the thread's start. */
  before: number | null | undefined;
}

/**
 * Whether the window has reached the live tail, so it can be dropped for the tail without
 * leaving a hole: it ends where the thread ends, shares an item with the tail, or the tail
 * holds the whole thread.
 */
export function meetsTail(window: JumpWindow, tail: TailEdge): boolean {
  if (window.after === null) return true;
  if (tail.before === null) return true;
  const last = window.items.at(-1);
  const lastSeq = last ? window.seqs.get(last.id) : undefined;
  if (typeof tail.before === "number" && lastSeq !== undefined && lastSeq >= tail.before)
    return true;
  const ids = new Set(tail.order);
  return window.items.some((item) => ids.has(item.id));
}

/** Whether the window holds this item. */
export function windowHas(window: JumpWindow, itemId: string): boolean {
  return window.seqs.has(itemId);
}
