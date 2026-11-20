import {
  deckGroups,
  findGroup,
  type DeckGroup,
  type DeckLayout,
  type DeckNode,
  type DeckOps,
  type DeckTab,
  type SplitSide,
} from "./layout.ts";

/*
 * A stand-in for W1's model (`@ace/ui-core/editor-workbench`) so the view, its tests and its
 * dev harness run before W1 lands on this branch. It implements only what the view asks for, by
 * the spec's rules (docs/editor/workbench.md 15–18, 22). Once W1 merges, the Deck is given W1's
 * functions and this file is deleted: two copies of the rules would be a bug.
 */

/** Spec 15: at most nine groups. */
const maxGroups = 9;

export function createInterimOps(newId: () => string): DeckOps {
  return {
    focus: (layout, group) => (findGroup(layout, group) ? { ...layout, focused: group } : layout),
    activate: (layout, group, path) => ({
      ...updateGroup(layout, group, (node) => show(node, path)),
      focused: group,
    }),
    keep: (layout, group, path) =>
      updateGroup(layout, group, (node) =>
        withTab(node, path, (tab) => ({ ...tab, preview: false })),
      ),
    setPinned: (layout, group, path, pinned) =>
      updateGroup(layout, group, (node) => {
        const tab = node.tabs.find((each) => each.path === path);
        if (!tab) return node;
        const rest = { ...node, tabs: node.tabs.filter((each) => each.path !== path) };
        const placed = { ...tab, pinned, preview: false };
        // Pinning puts it last among the pins; unpinning, first after them.
        return insert(rest, placed, pinnedCount(rest));
      }),
    close: (layout, group, paths) =>
      settle(
        updateGroup(layout, group, (node) => remove(node, paths)),
        group,
      ),
    move: (layout, from, to) => {
      const tab = findGroup(layout, from.group)?.tabs.find((each) => each.path === from.path);
      if (!tab || !findGroup(layout, to.group)) return layout;
      const kept = { ...tab, preview: false };
      const lifted =
        from.group === to.group
          ? layout
          : updateGroup(layout, from.group, (node) => remove(node, [tab.path]));
      const placed = updateGroup(lifted, to.group, (node) => {
        const index = from.group === to.group ? reorderIndex(node, tab.path, to.index) : to.index;
        const rest = { ...node, tabs: node.tabs.filter((each) => each.path !== tab.path) };
        return show(insert(rest, kept, index), tab.path);
      });
      return settle({ ...placed, focused: to.group }, to.group);
    },
    split: (layout, from, target, side, copy) => {
      const source = findGroup(layout, from.group);
      const tab = source?.tabs.find((each) => each.path === from.path);
      if (!source || !tab || deckGroups(layout.root).length >= maxGroups) return layout;
      if (!copy && from.group === target && source.tabs.length === 1) return layout;
      const fresh: DeckGroup = {
        kind: "group",
        id: newId(),
        tabs: [{ ...tab, preview: false }],
        active: tab.path,
        mru: [tab.path],
      };
      const placed = { ...layout, root: beside(layout.root, target, fresh, side) };
      const lifted = copy
        ? placed
        : updateGroup(placed, from.group, (node) => remove(node, [tab.path]));
      return settle({ ...lifted, focused: fresh.id }, fresh.id);
    },
    resize: (layout, at, sizes) => ({ ...layout, root: resizeAt(layout.root, at, sizes) }),
  };
}

function updateGroup(
  layout: DeckLayout,
  id: string,
  change: (group: DeckGroup) => DeckGroup,
): DeckLayout {
  const map = (node: DeckNode): DeckNode =>
    node.kind === "group"
      ? node.id === id
        ? change(node)
        : node
      : { ...node, children: node.children.map(map) };
  return { ...layout, root: map(layout.root) };
}

function withTab(group: DeckGroup, path: string, change: (tab: DeckTab) => DeckTab): DeckGroup {
  return { ...group, tabs: group.tabs.map((tab) => (tab.path === path ? change(tab) : tab)) };
}

function show(group: DeckGroup, path: string): DeckGroup {
  if (!group.tabs.some((tab) => tab.path === path)) return group;
  return { ...group, active: path, mru: [path, ...group.mru.filter((each) => each !== path)] };
}

function pinnedCount(group: DeckGroup): number {
  return group.tabs.filter((tab) => tab.pinned).length;
}

/** Insert at an index, kept inside the tab's own block: pinned tabs sit first (spec 22). */
function insert(group: DeckGroup, tab: DeckTab, index: number): DeckGroup {
  const pins = pinnedCount(group);
  const at = tab.pinned
    ? Math.min(Math.max(index, 0), pins)
    : Math.min(Math.max(index, pins), group.tabs.length);
  const tabs = [...group.tabs.slice(0, at), tab, ...group.tabs.slice(at)];
  return { ...group, tabs };
}

/** Dropping a tab at an index of its own strip: the index counts the tab itself. */
function reorderIndex(group: DeckGroup, path: string, index: number): number {
  const current = group.tabs.findIndex((tab) => tab.path === path);
  return current !== -1 && current < index ? index - 1 : index;
}

function remove(group: DeckGroup, paths: readonly string[]): DeckGroup {
  const gone = new Set(paths);
  const tabs = group.tabs.filter((tab) => !gone.has(tab.path));
  const mru = group.mru.filter((path) => !gone.has(path));
  if (group.active === undefined || !gone.has(group.active)) return { ...group, tabs, mru };
  const was = group.tabs.findIndex((tab) => tab.path === group.active);
  const next =
    mru.find((path) => tabs.some((tab) => tab.path === path)) ??
    tabs[Math.min(was, tabs.length - 1)]?.path;
  return { ...group, tabs, mru, active: next };
}

/** Drop emptied groups (never the last) and fold one-child splits; keep focus on a live group. */
function settle(layout: DeckLayout, preferred: string): DeckLayout {
  const before = deckGroups(layout.root);
  const root = prune(layout.root) ?? emptied(before, layout.focused);
  const after = deckGroups(root);
  if (after.some((group) => group.id === layout.focused)) return { root, focused: layout.focused };
  const at = before.findIndex((group) => group.id === preferred);
  const near =
    after.find((group) => group.id === preferred) ??
    after.find((group) => before.indexOf(group) > at) ??
    after.at(-1);
  return { root, focused: near?.id ?? layout.focused };
}

function prune(node: DeckNode): DeckNode | undefined {
  if (node.kind === "group") return node.tabs.length > 0 ? node : undefined;
  const kept = node.children.flatMap((child, index) => {
    const next = prune(child);
    return next ? [{ next, size: node.sizes[index] ?? 1 }] : [];
  });
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0]?.next;
  return {
    ...node,
    children: kept.map((each) => each.next),
    sizes: kept.map((each) => each.size),
  };
}

/** Every group emptied: the last group stays, empty (spec 17). */
function emptied(groups: readonly DeckGroup[], focused: string): DeckGroup {
  const keep = groups.find((group) => group.id === focused) ?? groups[0];
  return { kind: "group", id: keep?.id ?? focused, tabs: [], mru: [], active: undefined };
}

function beside(node: DeckNode, target: string, fresh: DeckGroup, side: SplitSide): DeckNode {
  const direction = side === "left" || side === "right" ? "row" : "column";
  const after = side === "right" || side === "down";
  if (node.kind === "group") {
    if (node.id !== target) return node;
    return {
      kind: "split",
      direction,
      sizes: [1, 1],
      children: after ? [node, fresh] : [fresh, node],
    };
  }
  const at = node.children.findIndex((child) => child.kind === "group" && child.id === target);
  if (at === -1 || node.direction !== direction)
    return { ...node, children: node.children.map((child) => beside(child, target, fresh, side)) };
  const half = (node.sizes[at] ?? 1) / 2;
  const children = [...node.children];
  const sizes = [...node.sizes];
  children.splice(after ? at + 1 : at, 0, fresh);
  sizes.splice(at, 1, half, half);
  return { ...node, children, sizes };
}

function resizeAt(node: DeckNode, at: readonly number[], sizes: readonly number[]): DeckNode {
  if (node.kind === "group") return node;
  const [head, ...rest] = at;
  if (head === undefined)
    return sizes.length === node.children.length ? { ...node, sizes: [...sizes] } : node;
  return {
    ...node,
    children: node.children.map((child, index) =>
      index === head ? resizeAt(child, rest, sizes) : child,
    ),
  };
}
