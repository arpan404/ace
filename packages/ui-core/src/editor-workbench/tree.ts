import {
  axisOf,
  evenSizes,
  insertGroup,
  isAfter,
  nodeAt,
  normalize,
  normalSizes,
  pathTo,
  replaceAt,
  walkGroups,
  withRoot,
} from "./nodes.ts";
import {
  defaultExplorer,
  limits,
  type EditorLayout,
  type GroupNode,
  type NewGroupId,
  type NodePath,
  type Side,
  type SplitNode,
} from "./types.ts";

/*
 * The Deck's split tree (spec 15, 17, 18): groups and row/column splits, focus, and room.
 * Every operation returns the same layout when nothing changed.
 */

/** The smallest share of a split one child keeps when an edge is dragged. */
const minimumShare = 0.05;

export const emptyGroup = (id: string): GroupNode => ({ kind: "group", id, tabs: [], mru: [] });

/** A Deck with one empty group, focused. */
export function emptyLayout(groupId: string): EditorLayout {
  return { root: emptyGroup(groupId), focused: groupId, explorer: defaultExplorer, closed: [] };
}

/** Every group in reading order (depth-first): Group 1, Group 2… */
export function groupsOf(layout: EditorLayout): readonly GroupNode[] {
  return walkGroups(layout.root);
}

export function findGroup(layout: EditorLayout, id: string): GroupNode | undefined {
  return groupsOf(layout).find((group) => group.id === id);
}

/** The focused group; the first group when the stored focus names none. */
export function focusedGroup(layout: EditorLayout): GroupNode {
  const groups = groupsOf(layout);
  const found = groups.find((group) => group.id === layout.focused) ?? groups[0];
  // A tree always holds a group: `normalize` never leaves a split without children.
  return found ?? emptyGroup(layout.focused);
}

export function focusGroup(layout: EditorLayout, id: string): EditorLayout {
  if (layout.focused === id || !findGroup(layout, id)) return layout;
  return { ...layout, focused: id };
}

/** ⌘1–⌘9: focus the group at this 1-based reading-order position; past the last, nothing. */
export function focusGroupAt(layout: EditorLayout, ordinal: number): EditorLayout {
  const group = groupsOf(layout)[ordinal - 1];
  return group ? focusGroup(layout, group.id) : layout;
}

/** Split right/down (and left/up): a second view of the group's active editor in a new group. */
export function splitGroup(
  layout: EditorLayout,
  groupId: string,
  side: Side,
  newGroupId: NewGroupId,
): EditorLayout {
  const group = findGroup(layout, groupId);
  if (!group || groupsOf(layout).length >= limits.groups) return layout;
  const active = group.tabs.find((tab) => tab.path === group.active);
  const id = newGroupId();
  const view: GroupNode = active
    ? {
        kind: "group",
        id,
        tabs: [{ ...active, preview: false, pinned: false }],
        active: active.path,
        mru: [active.path],
      }
    : emptyGroup(id);
  return { ...insertGroup(layout, groupId, side, view), focused: id };
}

/** Remove a group; its neighbour takes its room. The last group never goes. */
export function removeGroup(layout: EditorLayout, groupId: string): EditorLayout {
  const at = pathTo(layout.root, groupId);
  if (!at || at.length === 0) return layout;
  const parentAt = at.slice(0, -1);
  const parent = nodeAt(layout.root, parentAt);
  const index = at.at(-1) ?? 0;
  if (parent?.kind !== "split") return layout;
  const sizes = normalSizes(parent.sizes, parent.children.length);
  const removed = sizes[index] ?? 0;
  // The neighbour before takes the room; the first child's goes to the one after it.
  const heir = index > 0 ? index - 1 : 1;
  const nextSizes = sizes.map((size, i) => (i === heir ? size + removed : size));
  nextSizes.splice(index, 1);
  const children = parent.children.filter((_, i) => i !== index);
  const replaced = replaceAt(layout.root, parentAt, () => ({
    ...parent,
    children,
    sizes: nextSizes,
  }));
  const root = normalize(replaced) ?? layout.root;
  if (layout.focused !== groupId) return withRoot(layout, root);
  const heirNode = parent.children[heir];
  const heirGroups = heirNode ? walkGroups(heirNode) : [];
  const focus = (index > 0 ? heirGroups.at(-1) : heirGroups[0]) ?? walkGroups(root)[0];
  return { ...withRoot(layout, root), focused: focus?.id ?? layout.focused };
}

/** The group beside this one on that side, if any: the nearest one across the shared edge. */
export function adjacentGroup(
  layout: EditorLayout,
  groupId: string,
  side: Side,
): GroupNode | undefined {
  const at = pathTo(layout.root, groupId);
  if (!at) return undefined;
  const direction = axisOf(side);
  const step = isAfter(side) ? 1 : -1;
  for (let depth = at.length - 1; depth >= 0; depth -= 1) {
    const parent = nodeAt(layout.root, at.slice(0, depth));
    const index = at[depth] ?? 0;
    if (parent?.kind !== "split" || parent.direction !== direction) continue;
    const sibling = parent.children[index + step];
    if (!sibling) continue;
    return nearestGroup(sibling, direction, step > 0);
  }
  return undefined;
}

/** Descend into `node` from one edge: the group touching the edge it is entered from. */
function nearestGroup(
  node: SplitNode,
  direction: "row" | "column",
  fromStart: boolean,
): GroupNode | undefined {
  if (node.kind === "group") return node;
  const children = node.children;
  const child =
    node.direction === direction && !fromStart ? children[children.length - 1] : children[0];
  return child && nearestGroup(child, direction, fromStart);
}

/** Drag a split edge: new fractions for the split at `at`, each kept above a minimum share. */
export function resizeSplit(
  layout: EditorLayout,
  at: NodePath,
  sizes: readonly number[],
): EditorLayout {
  const node = nodeAt(layout.root, at);
  if (node?.kind !== "split" || sizes.length !== node.children.length) return layout;
  if (!sizes.every((size) => Number.isFinite(size) && size >= 0)) return layout;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return layout;
  const floored = sizes.map((size) => Math.max(size / total, minimumShare));
  const next = normalSizes(floored, floored.length);
  return withRoot(
    layout,
    replaceAt(layout.root, at, () => ({ ...node, sizes: next })),
  );
}

/** Double-click a split edge: even sizes for the split at `at`. */
export function evenSplit(layout: EditorLayout, at: NodePath): EditorLayout {
  const node = nodeAt(layout.root, at);
  if (node?.kind !== "split") return layout;
  const even = evenSizes(node.children.length);
  if (even.every((size, index) => Math.abs(size - (node.sizes[index] ?? -1)) < 1e-9)) {
    return layout;
  }
  return withRoot(
    layout,
    replaceAt(layout.root, at, () => ({ ...node, sizes: even })),
  );
}
