import { insertTab, removeTab, touch, updateGroup } from "./nodes.ts";
import { findGroup, focusedGroup, groupsOf, removeGroup } from "./tree.ts";
import { limits, type ClosedEditor, type EditorLayout, type TabRef } from "./types.ts";

/*
 * Closing (spec 17, 22, 24, 25, 48): the close variants, the rule that the last view of an
 * unsaved file never closes without asking, group pruning, and the closed stack.
 */

/** The tab menu's close variants (spec 24). `all` is every tab of the group, pinned or not. */
export type CloseWhich = "others" | "right" | "saved" | "all";

/**
 * The tabs a close variant would close, around `ref` in its group. Pinned tabs stay for every
 * variant but `all`; `saved` leaves tabs whose file has unsaved edits.
 */
export function tabsToClose(
  layout: EditorLayout,
  ref: TabRef,
  which: CloseWhich,
  unsaved: ReadonlySet<string>,
): readonly TabRef[] {
  const group = findGroup(layout, ref.group);
  if (!group) return [];
  const index = group.tabs.findIndex((tab) => tab.path === ref.path);
  const chosen = group.tabs.filter((tab, at) => {
    if (which === "all") return true;
    if (tab.pinned) return false;
    if (which === "others") return tab.path !== ref.path;
    if (which === "right") return index >= 0 && at > index;
    return !unsaved.has(tab.path);
  });
  return chosen.map((tab) => ({ group: group.id, path: tab.path }));
}

export interface CloseResult {
  layout: EditorLayout;
  /** Tabs left open because closing them would lose unsaved text: ask, then `discardTabs`. */
  asking: readonly TabRef[];
}

const sameRef = (a: TabRef, b: TabRef) => a.group === b.group && a.path === b.path;

/**
 * Close tabs. A file with unsaved edits keeps its tabs when they are its last views; they come
 * back in `asking` for one dialog. Closing one of several views of it loses nothing and closes.
 */
export function closeTabs(
  layout: EditorLayout,
  refs: readonly TabRef[],
  unsaved: ReadonlySet<string>,
): CloseResult {
  const asking: TabRef[] = [];
  const closing: TabRef[] = [];
  for (const ref of refs) {
    if (!unsaved.has(ref.path)) {
      closing.push(ref);
      continue;
    }
    const remaining = groupsOf(layout).some(
      (group) =>
        group.tabs.some((tab) => tab.path === ref.path) &&
        !refs.some((other) => sameRef(other, { group: group.id, path: ref.path })),
    );
    (remaining ? closing : asking).push(ref);
  }
  return { layout: discardTabs(layout, closing), asking };
}

/** Close tabs after the person answered (Save or Don't save). Emptied groups close. */
export function discardTabs(layout: EditorLayout, refs: readonly TabRef[]): EditorLayout {
  let next = layout;
  const closed: ClosedEditor[] = [];
  for (const ref of refs) {
    const group = findGroup(next, ref.group);
    const index = group?.tabs.findIndex((tab) => tab.path === ref.path) ?? -1;
    const tab = group?.tabs[index];
    if (!group || !tab) continue;
    closed.unshift({ group: group.id, index, tab });
    next = updateGroup(next, group.id, (each) => removeTab(each, ref.path));
  }
  if (closed.length === 0) return layout;
  for (const group of groupsOf(next)) {
    if (group.tabs.length === 0) next = removeGroup(next, group.id);
  }
  return { ...next, closed: [...closed, ...next.closed].slice(0, limits.closed) };
}

/** Reopen the last closed editor in its group at its index, with its view state. */
export function reopenClosed(layout: EditorLayout): EditorLayout {
  const [last, ...rest] = layout.closed;
  if (!last) return layout;
  const target = findGroup(layout, last.group) ?? focusedGroup(layout);
  const popped: EditorLayout = { ...layout, closed: rest, focused: target.id };
  return updateGroup(popped, target.id, (group) => {
    if (group.tabs.some((tab) => tab.path === last.tab.path)) return touch(group, last.tab.path);
    // One preview per group: a closed preview that would make a second one comes back kept.
    const preview = last.tab.preview && group.tabs.some((tab) => tab.preview);
    const tab = preview ? { ...last.tab, preview: false } : last.tab;
    const index = target.id === last.group ? last.index : group.tabs.length;
    return insertTab(group, tab, index);
  });
}
