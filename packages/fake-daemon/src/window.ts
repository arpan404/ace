import { inRootLane, retainedTail } from "@ace/projection";
import type { Item, ItemsPage, TextSource, ThreadView } from "@ace/protocol";

function seqs(ids: readonly string[], creation: ReadonlyMap<string, number>) {
  const result: Record<string, number> = {};
  for (const id of ids) {
    const seq = creation.get(id);
    if (seq !== undefined) result[id] = seq;
  }
  return result;
}
/** UTF-16 units of one text a snapshot or page carries; the rest is named by its source. */
export const previewUnits = 16 * 1024;
/**
 * The daemon bounds what a snapshot or history page carries of a long text (its previews, within
 * a 1 MiB window), however long the item has streamed. Here a longer text keeps its newest
 * `previewUnits`, where a live stream's deltas continue, with a source that names the whole, so a
 * client marks it clipped. Without this, a message streamed for hours made one oversized frame.
 */
function bounded(item: Item): Item {
  const clip = (text: string, part: number, source: TextSource | undefined) => {
    if (text.length <= previewUnits) return { text, source };
    return {
      text: text.slice(-previewUnits),
      source: {
        streamId: source?.streamId ?? `text:${JSON.stringify([item.id, part])}`,
        bytes: text.length * 2,
        encoding: "utf-16le" as const,
      },
    };
  };
  if (item.type === "message") {
    if (!item.parts.some((part) => part.type === "text" && part.text.length > previewUnits))
      return structuredClone(item);
    const { parts, ...rest } = item;
    return {
      ...structuredClone(rest),
      parts: parts.map((part, index) => {
        if (part.type !== "text") return structuredClone(part);
        const { text, source } = clip(part.text, index, part.source);
        const copy: typeof part = { type: "text", text };
        if (source) copy.source = source;
        return copy;
      }),
    };
  }
  if ((item.type === "reasoning" || item.type === "notice") && item.text.length > previewUnits) {
    const { text: whole, ...rest } = item;
    const { text, source } = clip(whole, 0, item.source);
    return { ...structuredClone(rest), text, ...(source ? { source } : {}) };
  }
  return structuredClone(item);
}
function pick(view: ThreadView, ids: readonly string[]): Item[] {
  const items: Item[] = [];
  for (const id of ids) {
    const item = Object.hasOwn(view.items, id) ? view.items[id] : undefined;
    if (item) items.push(bounded(item));
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
