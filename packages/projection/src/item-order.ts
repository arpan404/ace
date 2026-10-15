import type { Item } from "@ace/protocol";

/** Chronological display order; creation cursors settle equal timestamps when available.
 * Items without cursors follow equal-time known items, retaining their input order. */
export function chronologicalItemOrder(
  order: readonly string[],
  item: (id: string) => Item | undefined,
  creation?: (id: string) => number | undefined,
): string[] {
  return order.toSorted(
    (a, b) =>
      (item(a)?.createdAt ?? Infinity) - (item(b)?.createdAt ?? Infinity) ||
      (creation?.(a) ?? Infinity) - (creation?.(b) ?? Infinity),
  );
}

/** Live creation sequences increase, so equal timestamps belong after existing items.
 * The ordinary append path is constant time; late items use binary search plus one splice. */
export function insertChronologicalItem(
  order: string[],
  items: Readonly<Record<string, Item>>,
  item: Item,
): void {
  let low = 0;
  let high = order.length;
  const last = order.at(-1);
  if (!last || (items[last]?.createdAt ?? Infinity) <= item.createdAt) {
    order.push(item.id);
    return;
  }
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[order[middle] ?? ""]?.createdAt ?? Infinity) <= item.createdAt) low = middle + 1;
    else high = middle;
  }
  order.splice(low, 0, item.id);
}
