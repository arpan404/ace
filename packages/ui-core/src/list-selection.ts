/*
 * Picking several Home threads at once for a bulk action: ⌘- or Ctrl-click (or x) adds or
 * removes one, Shift-click (or Shift+↑↓) takes everything from the last one picked. Pure; the
 * web app keeps one per window.
 */

export interface ListSelection {
  ids: readonly string[];
  /** The thread a range starts from: the last one picked on its own. */
  anchor: string | undefined;
}

export const noSelection: ListSelection = { ids: [], anchor: undefined };

/** Add `id` if it isn't picked, else drop it; either way a range starts from it next. */
export function toggleSelected(selection: ListSelection, id: string): ListSelection {
  const ids = selection.ids.includes(id)
    ? selection.ids.filter((picked) => picked !== id)
    : [...selection.ids, id];
  return { ids, anchor: id };
}

/**
 * Everything from the anchor to `id` in list order, in place of what the last range took. With
 * no anchor (or one no longer listed) it starts at `id`.
 */
export function selectRange(
  selection: ListSelection,
  order: readonly string[],
  id: string,
): ListSelection {
  const to = order.indexOf(id);
  if (to < 0) return selection;
  const anchor =
    selection.anchor !== undefined && order.includes(selection.anchor) ? selection.anchor : id;
  const from = order.indexOf(anchor);
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { ids: range, anchor };
}

/** Only the picked threads still listed, in list order: a thread archived elsewhere drops out. */
export function listedSelection(selection: ListSelection, order: readonly string[]): ListSelection {
  const picked = new Set(selection.ids);
  const ids = order.filter((id) => picked.has(id));
  if (ids.length === selection.ids.length && ids.every((id, i) => id === selection.ids[i]))
    return selection;
  const anchor =
    selection.anchor !== undefined && order.includes(selection.anchor)
      ? selection.anchor
      : undefined;
  return { ids, anchor };
}
