import { mergeBySeq } from "@ace/projection";
import type { ItemsPage } from "@ace/protocol";
import { ClientError } from "./types.ts";

/**
 * Where an older page lands in a leased window. Paging only fills the window's free capacity
 * and never evicts the live tail (ADR 0062): the page's newest items are admitted first, so the
 * window stays contiguous, and deeper history is read through a detached window instead. Items
 * merge by creation sequence because a window may hold older root items it retained. Unknown
 * cursors are rejected rather than inventing an order that could hide or skip history.
 */
export function pageWindow(
  current: readonly string[],
  creation: ReadonlyMap<string, number>,
  page: ItemsPage,
  capacity: number,
): { order: readonly string[]; admitted: ReadonlySet<string>; before: number | null | undefined } {
  const sequences = new Map(creation);
  for (const item of page.items) {
    const seq = page.itemSeqs?.[item.id] ?? sequences.get(item.id);
    if (seq === undefined) throw new ClientError("stale", "History page needs creation cursors");
    sequences.set(item.id, seq);
  }
  for (const id of current)
    if (!sequences.has(id)) throw new ClientError("stale", "History window needs creation cursors");
  const held = new Set(current);
  const fresh = page.items.filter((item) => !held.has(item.id)).map((item) => item.id);
  const room = Math.max(0, capacity - current.length);
  const admitted = fresh.slice(Math.max(0, fresh.length - room));
  if (!admitted.length)
    // Nothing new fits. A page of items already held still moves the cursor past them.
    return {
      order: current,
      admitted: new Set(),
      before: fresh.length ? undefined : page.itemsBefore,
    };
  return {
    order: mergeBySeq(admitted, current, (id) => sequences.get(id)),
    admitted: new Set(admitted),
    // A partly admitted page leaves its older items before the oldest one admitted.
    before: admitted.length === fresh.length ? page.itemsBefore : sequences.get(admitted[0] ?? ""),
  };
}
