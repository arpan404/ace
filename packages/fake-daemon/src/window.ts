import { inRootLane, retainedTail } from "@ace/projection";
import type { Item, ItemsPage, ThreadView } from "@ace/protocol";

function seqs(ids: readonly string[], creation: ReadonlyMap<string, number>) {
  const result: Record<string, number> = {};
  for (const id of ids) {
    const seq = creation.get(id);
    if (seq !== undefined) result[id] = seq;
  }
  return result;
}
function pick(view: ThreadView, ids: readonly string[]): Item[] {
  const items: Item[] = [];
  for (const id of ids) {
    const item = Object.hasOwn(view.items, id) ? view.items[id] : undefined;
    if (item) items.push(structuredClone(item));
  }
  return items;
}
function cursor(
  shown: readonly string[],
  total: number,
  creation: ReadonlyMap<string, number>,
): number | null {
  const first = shown[0];
  return shown.length < total && first !== undefined ? (creation.get(first) ?? null) : null;
}

/**
 * ADR 0006 snapshot: every status entity, but only the tail of `limit` items the daemon's
 * snapshot keeps (its newest items, with the root agent's share), in creation order.
 */
export function windowSnapshot(
  view: ThreadView,
  creation: ReadonlyMap<string, number>,
  limit: number,
  seq: number,
): ThreadView {
  const root = view.thread.rootAgentId;
  const tail = retainedTail(
    view.itemOrder.map((id) => ({
      id,
      seq: creation.get(id),
      root: inRootLane(view.items[id]?.agentId, root),
    })),
    limit,
  );
  const kept = tail.kept.map((entry) => entry.id);
  const { items: _items, itemOrder: _order, ...rest } = view;
  return {
    ...structuredClone(rest),
    seq,
    items: Object.fromEntries(pick(view, kept).map((item) => [item.id, item])),
    itemOrder: kept,
    itemSeqs: seqs(kept, creation),
    itemsBefore: tail.before ?? null,
  };
}

/** Older items strictly before an exclusive creation cursor, oldest first. */
export function historyPage(
  view: ThreadView,
  creation: ReadonlyMap<string, number>,
  before: number,
  limit: number,
  seq: number,
): ItemsPage {
  const older = view.itemOrder.filter((id) => (creation.get(id) ?? Infinity) < before);
  const slice = older.slice(-limit);
  return {
    seq,
    threadId: view.thread.id,
    items: pick(view, slice),
    itemSeqs: seqs(slice, creation),
    itemsBefore: cursor(slice, older.length, creation),
  };
}
