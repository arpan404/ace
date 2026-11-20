import type {
  EditorLayout,
  EditorTab,
  GroupNode,
  NodePath,
  Side,
  SplitBranch,
  SplitNode,
} from "./types.ts";

/*
 * Tree and group plumbing the public operations share. Not exported from the package: callers
 * work through the operations, which keep the tree's invariants.
 */

export function walkGroups(node: SplitNode, into: GroupNode[] = []): GroupNode[] {
  if (node.kind === "group") into.push(node);
  else for (const child of node.children) walkGroups(child, into);
  return into;
}

export function pathTo(node: SplitNode, groupId: string, at: number[] = []): number[] | undefined {
  if (node.kind === "group") return node.id === groupId ? at : undefined;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const found = child && pathTo(child, groupId, [...at, index]);
    if (found) return found;
  }
  return undefined;
}

export function nodeAt(node: SplitNode, at: NodePath): SplitNode | undefined {
  let current: SplitNode | undefined = node;
  for (const index of at) {
    if (current?.kind !== "split") return undefined;
    current = current.children[index];
  }
  return current;
}

/** Replace the node at `at`; the same root when `change` returns the node it was given. */
export function replaceAt(
  node: SplitNode,
  at: NodePath,
  change: (node: SplitNode) => SplitNode,
): SplitNode {
  if (at.length === 0) return change(node);
  if (node.kind !== "split") return node;
  const [index, ...rest] = at;
  const child = index === undefined ? undefined : node.children[index];
  if (!child) return node;
  const next = replaceAt(child, rest, change);
  if (next === child) return node;
  return { ...node, children: node.children.map((each, i) => (i === index ? next : each)) };
}

export function withRoot(layout: EditorLayout, root: SplitNode): EditorLayout {
  return root === layout.root ? layout : { ...layout, root };
}

/** Change one group; the same layout when the group is missing or `change` returns it as is. */
export function updateGroup(
  layout: EditorLayout,
  groupId: string,
  change: (group: GroupNode) => GroupNode,
): EditorLayout {
  const at = pathTo(layout.root, groupId);
  if (!at) return layout;
  return withRoot(
    layout,
    replaceAt(layout.root, at, (node) => (node.kind === "group" ? change(node) : node)),
  );
}

export const axisOf = (side: Side): SplitBranch["direction"] =>
  side === "left" || side === "right" ? "row" : "column";
export const isAfter = (side: Side): boolean => side === "right" || side === "down";

export function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Positive fractions summing to 1, one per child; even when the given ones can't be used. */
export function normalSizes(sizes: readonly unknown[], count: number): number[] {
  const numbers = sizes.filter(
    (size): size is number => typeof size === "number" && Number.isFinite(size) && size > 0,
  );
  if (sizes.length !== count || numbers.length !== count) return evenSizes(count);
  const total = numbers.reduce((sum, size) => sum + size, 0);
  return numbers.map((size) => size / total);
}

/**
 * Restore the tree's shape after a removal: splits with one child give way to it, a split inside
 * one of its own direction is flattened into it (its sizes scaled into its slot), and empty splits
 * go. Undefined when nothing is left.
 */
export function normalize(node: SplitNode): SplitNode | undefined {
  if (node.kind === "group") return node;
  const children: SplitNode[] = [];
  const sizes: number[] = [];
  const given = normalSizes(node.sizes, node.children.length);
  node.children.forEach((child, index) => {
    const kept = normalize(child);
    const size = given[index] ?? 0;
    if (!kept) return;
    if (kept.kind === "split" && kept.direction === node.direction) {
      kept.children.forEach((grandchild, inner) => {
        children.push(grandchild);
        sizes.push(size * (kept.sizes[inner] ?? 0));
      });
      return;
    }
    children.push(kept);
    sizes.push(size);
  });
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  const same =
    children.length === node.children.length &&
    children.every((child, index) => child === node.children[index]);
  const normal = normalSizes(sizes, children.length);
  if (same && normal.every((size, index) => Math.abs(size - (node.sizes[index] ?? -1)) < 1e-9)) {
    return node;
  }
  return { ...node, children, sizes: normal };
}

/** Put `group` beside the group `besideId`, halving that group's room. */
export function insertGroup(
  layout: EditorLayout,
  besideId: string,
  side: Side,
  group: GroupNode,
): EditorLayout {
  const at = pathTo(layout.root, besideId);
  if (!at) return layout;
  const direction = axisOf(side);
  const after = isAfter(side);
  const parentAt = at.slice(0, -1);
  const parent = at.length > 0 ? nodeAt(layout.root, parentAt) : undefined;
  const index = at.at(-1) ?? 0;
  if (parent?.kind === "split" && parent.direction === direction) {
    const half = (normalSizes(parent.sizes, parent.children.length)[index] ?? 0) / 2;
    const slot = after ? index + 1 : index;
    const children = [...parent.children];
    children.splice(slot, 0, group);
    const sizes = normalSizes(parent.sizes, parent.children.length);
    sizes.splice(index, 1, half, half);
    return withRoot(
      layout,
      replaceAt(layout.root, parentAt, () => ({ ...parent, children, sizes })),
    );
  }
  return withRoot(
    layout,
    replaceAt(layout.root, at, (node) => ({
      kind: "split",
      direction,
      sizes: [0.5, 0.5],
      children: after ? [node, group] : [group, node],
    })),
  );
}

/** Tabs in strip order: pinned ones first in their order, at most one preview, never pinned. */
export function stripOrder(tabs: readonly EditorTab[]): EditorTab[] {
  const pinned: EditorTab[] = [];
  const rest: EditorTab[] = [];
  let previewSeen = false;
  for (const tab of tabs) {
    let placed = tab;
    if (tab.preview && (tab.pinned || previewSeen)) placed = { ...tab, preview: false };
    else if (tab.preview) previewSeen = true;
    (tab.pinned ? pinned : rest).push(placed);
  }
  return [...pinned, ...rest];
}

export function pinnedCount(tabs: readonly EditorTab[]): number {
  let count = 0;
  while (tabs[count]?.pinned) count += 1;
  return count;
}

/** The group with `path` showing and first in its MRU. */
export function touch(group: GroupNode, path: string): GroupNode {
  if (group.active === path && group.mru[0] === path) return group;
  return { ...group, active: path, mru: [path, ...group.mru.filter((each) => each !== path)] };
}

/** Insert a tab (not open in the group) at `index`, kept inside its pinned or unpinned zone. */
export function insertTab(group: GroupNode, tab: EditorTab, index: number | undefined): GroupNode {
  const pins = pinnedCount(group.tabs);
  const activeIndex = group.tabs.findIndex((each) => each.path === group.active);
  const wanted = index ?? (activeIndex >= 0 ? activeIndex + 1 : group.tabs.length);
  const slot = tab.pinned
    ? Math.min(Math.max(wanted, 0), pins)
    : Math.min(Math.max(wanted, pins), group.tabs.length);
  const tabs = [...group.tabs];
  tabs.splice(slot, 0, tab);
  return touch({ ...group, tabs }, tab.path);
}

/** Remove a tab; the most recently used remaining tab shows next. */
export function removeTab(group: GroupNode, path: string): GroupNode {
  const index = group.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return group;
  const tabs = group.tabs.filter((tab) => tab.path !== path);
  const mru = group.mru.filter((each) => each !== path);
  const active =
    group.active !== path
      ? group.active
      : (mru.find((each) => tabs.some((tab) => tab.path === each)) ??
        tabs[Math.min(index, tabs.length - 1)]?.path);
  return { ...group, tabs, mru, active };
}

/** Move a tab already in the group to `index`, kept inside its zone. */
export function reorderTab(group: GroupNode, path: string, index: number): GroupNode {
  const from = group.tabs.findIndex((tab) => tab.path === path);
  const tab = group.tabs[from];
  if (!tab) return group;
  const rest = group.tabs.filter((each) => each.path !== path);
  const pins = pinnedCount(rest);
  const wanted = index > from ? index - 1 : index;
  const slot = tab.pinned
    ? Math.min(Math.max(wanted, 0), pins)
    : Math.min(Math.max(wanted, pins), rest.length);
  if (slot === from) return touch(group, path);
  const tabs = [...rest];
  tabs.splice(slot, 0, tab);
  return touch({ ...group, tabs }, path);
}

export function changeTab(
  group: GroupNode,
  path: string,
  change: (tab: EditorTab) => EditorTab,
): GroupNode {
  let changed = false;
  const tabs = group.tabs.map((tab) => {
    if (tab.path !== path) return tab;
    const next = change(tab);
    changed ||= next !== tab;
    return next;
  });
  return changed ? { ...group, tabs } : group;
}
