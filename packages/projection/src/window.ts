import type { Item, ItemsPage, ThreadView } from "@ace/protocol";

/** A detail view seeds the item it tracks, so later updates/deltas keep applying. */
export function trackItem(view: ThreadView, item: Item): void {
  Object.defineProperty(view.items, item.id, {
    value: JSON.parse(JSON.stringify(item)) as Item,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
/** Merge older history without overwriting newer live values or moving the sync cursor. */
export function applyItemsPage(view: ThreadView, page: ItemsPage): void {
  if (page.threadId !== view.thread.id) throw new Error("Page outside thread scope");
  const older: string[] = [];
  const ordered = new Set(view.itemOrder);
  for (const item of page.items) {
    if (!Object.hasOwn(view.items, item.id)) trackItem(view, item);
    if (!ordered.has(item.id)) {
      older.push(item.id);
      ordered.add(item.id);
    }
  }
  view.itemOrder = [...older, ...view.itemOrder];
  // Exclusive creation cursors only move backward; reaching the start is final.
  if (view.itemsBefore !== null)
    view.itemsBefore =
      page.itemsBefore === null ? null : Math.min(view.itemsBefore, page.itemsBefore);
}
