import type { ThreadView } from "@ace/protocol";

/** Select before cloning: copying the full transcript defeats the window. */
export function snapshotWindow(view: ThreadView): ThreadView {
  const selected: string[] = [];
  let bytes = 0;
  for (let index = view.itemOrder.length - 1; index >= 0 && selected.length < 200; index--) {
    const id = view.itemOrder[index];
    if (!id) continue;
    const item = view.items[id];
    if (!item) continue;
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 1024 * 1024) {
      if (!selected.length) throw new Error("item_too_large");
      break;
    }
    bytes += size;
    selected.push(id);
  }
  selected.reverse();
  const items = Object.fromEntries(
    selected.flatMap((id) => {
      const item = view.items[id];
      return item ? [[id, item]] : [];
    }),
  );
  const before =
    selected.length < view.itemOrder.length ? (selected[0] ?? view.itemOrder.at(-1) ?? null) : null;
  return structuredClone({ ...view, items, itemOrder: selected, itemsBefore: before });
}
