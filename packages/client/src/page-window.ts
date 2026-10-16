import type { ItemsPage } from "@ace/protocol";
import { ClientError } from "./types.ts";
/** Page admission is independent of arrival order. Unknown legacy cursors are rejected,
 * rather than inventing an order that could hide or skip history. */
export function pageWindow(
  current: readonly string[],
  creation: ReadonlyMap<string, number>,
  page: ItemsPage,
  capacity: number,
): { order: string[]; before: number | null } {
  const sequences = new Map(creation);
  for (const item of page.items) {
    const seq = page.itemSeqs?.[item.id] ?? sequences.get(item.id);
    if (seq === undefined) throw new ClientError("stale", "History page needs creation cursors");
    sequences.set(item.id, seq);
  }
  const ids = new Set([...current, ...page.items.map((item) => item.id)]);
  for (const id of ids)
    if (!sequences.has(id)) throw new ClientError("stale", "History window needs creation cursors");
  const order = [...ids]
    .toSorted((a, b) => (sequences.get(a) ?? 0) - (sequences.get(b) ?? 0))
    .slice(0, capacity);
  // The cursor describes the beginning of the retained window, never the most recent response.
  const first = order[0];
  const pageFirst = page.items[0]?.id;
  const before =
    first === pageFirst
      ? page.itemsBefore
      : first
        ? (sequences.get(first) ?? null)
        : page.itemsBefore;
  return { order, before };
}
