import {
  changeTab,
  insertGroup,
  insertTab,
  removeTab,
  reorderTab,
  touch,
  updateGroup,
} from "./nodes.ts";
import { emptyGroup, findGroup, focusedGroup, groupsOf, removeGroup } from "./tree.ts";
import {
  limits,
  type EditorLayout,
  type EditorTab,
  type GroupNode,
  type NewGroupId,
  type Side,
  type TabRef,
} from "./types.ts";

/*
 * Drag and drop (spec 16, 17, 27): where a pointer drops, and what a drop does. A dragged tab is
 * kept; a group emptied by a move closes unless it is the last.
 */

/** Where a drop lands (spec 16). */
export type DropTarget =
  | { kind: "strip"; group: string; index: number }
  | { kind: "group"; group: string }
  | { kind: "side"; group: string; side: Side };

/** Over a group's editor: the middle third moves into the group, an outer third splits that side. */
export function dropZone(
  point: { x: number; y: number },
  box: { width: number; height: number },
): "center" | Side {
  if (box.width <= 0 || box.height <= 0) return "center";
  const x = point.x / box.width;
  const y = point.y / box.height;
  const edges: [Side, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["up", y],
    ["down", 1 - y],
  ];
  let nearest = edges[0];
  for (const edge of edges) if (nearest && edge[1] < nearest[1]) nearest = edge;
  return nearest && nearest[1] < 1 / 3 ? nearest[0] : "center";
}

/** Over a strip: the insertion index for a pointer at `x`, from the tabs' boxes. */
export function stripIndex(tabs: readonly { left: number; width: number }[], x: number): number {
  return tabs.filter((tab) => tab.left + tab.width / 2 < x).length;
}

interface Landing {
  layout: EditorLayout;
  group: string;
  index: number | undefined;
}

/** The group a drop lands in, creating it for a side drop while there is room for one more. */
function land(
  layout: EditorLayout,
  target: DropTarget,
  newGroupId: NewGroupId,
): Landing | undefined {
  if (!findGroup(layout, target.group)) return undefined;
  if (target.kind === "strip") return { layout, group: target.group, index: target.index };
  if (target.kind === "group" || groupsOf(layout).length >= limits.groups) {
    return { layout, group: target.group, index: undefined };
  }
  const id = newGroupId();
  return {
    layout: insertGroup(layout, target.group, target.side, emptyGroup(id)),
    group: id,
    index: undefined,
  };
}

/** Put a kept tab in a group: an open one comes forward (moved to `index` when given). */
function place(group: GroupNode, tab: EditorTab, index: number | undefined): GroupNode {
  const kept = tab.preview ? { ...tab, preview: false } : tab;
  if (!group.tabs.some((each) => each.path === tab.path)) return insertTab(group, kept, index);
  const unpreviewed = changeTab(group, tab.path, (each) =>
    each.preview ? { ...each, preview: false } : each,
  );
  return index === undefined
    ? touch(unpreviewed, tab.path)
    : reorderTab(unpreviewed, tab.path, index);
}

function finish(layout: EditorLayout, focus: string, source?: string): EditorLayout {
  const emptied = source !== undefined && findGroup(layout, source)?.tabs.length === 0;
  const pruned = emptied ? removeGroup(layout, source) : layout;
  return pruned.focused === focus ? pruned : { ...pruned, focused: focus };
}

/** Drag a tab: it moves (kept) and a group emptied by the move closes unless it is the last. */
export function moveTab(
  layout: EditorLayout,
  from: TabRef,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  const tab = findGroup(layout, from.group)?.tabs.find((each) => each.path === from.path);
  if (!tab) return layout;
  if (target.kind !== "side" && target.group === from.group) {
    const index = target.kind === "strip" ? target.index : undefined;
    return finish(
      updateGroup(layout, from.group, (group) => place(group, tab, index)),
      from.group,
    );
  }
  // A side drop on the tab's only group would empty it into its own new neighbour: nothing moves.
  if (target.kind === "side" && target.group === from.group) {
    const only = findGroup(layout, from.group)?.tabs.length === 1;
    if (only) return layout;
  }
  const landing = land(layout, target, newGroupId);
  if (!landing) return layout;
  if (landing.group === from.group) return finish(layout, from.group);
  const removed = updateGroup(landing.layout, from.group, (group) => removeTab(group, from.path));
  const placed = updateGroup(removed, landing.group, (group) => place(group, tab, landing.index));
  return finish(placed, landing.group, from.group);
}

/** ⌥-drag: a second view at the target; the original stays. */
export function copyTab(
  layout: EditorLayout,
  from: TabRef,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  const tab = findGroup(layout, from.group)?.tabs.find((each) => each.path === from.path);
  if (!tab || (target.kind !== "side" && target.group === from.group)) return layout;
  const landing = land(layout, target, newGroupId);
  if (!landing) return layout;
  const view: EditorTab = { ...tab, preview: false, pinned: false };
  return finish(
    updateGroup(landing.layout, landing.group, (group) => place(group, view, landing.index)),
    landing.group,
  );
}

/** A file dragged from the explorer opens at the target, kept. */
export function dropFile(
  layout: EditorLayout,
  path: string,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  const landing = land(layout, target, newGroupId);
  if (!landing) return layout;
  const tab: EditorTab = { path, preview: false, pinned: false };
  return finish(
    updateGroup(landing.layout, landing.group, (group) => place(group, tab, landing.index)),
    landing.group,
  );
}

/**
 * ⌃⌘← / ⌃⌘→: move the focused group's active editor to the previous or next group in reading
 * order. Past the last group, a new group opens to the right for it (while there is room and
 * the editor isn't its group's only one).
 */
export function moveActiveEditor(
  layout: EditorLayout,
  toward: "previous" | "next",
  newGroupId: NewGroupId,
): EditorLayout {
  const group = focusedGroup(layout);
  if (group.active === undefined) return layout;
  const groups = groupsOf(layout);
  const at = groups.findIndex((each) => each.id === group.id);
  const neighbour = groups[toward === "next" ? at + 1 : at - 1];
  const from = { group: group.id, path: group.active };
  if (neighbour) return moveTab(layout, from, { kind: "group", group: neighbour.id }, newGroupId);
  if (toward === "previous" || group.tabs.length < 2) return layout;
  if (groups.length >= limits.groups) return layout;
  return moveTab(layout, from, { kind: "side", group: group.id, side: "right" }, newGroupId);
}
