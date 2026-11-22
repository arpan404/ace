import { insertGroup } from "./nodes.ts";
import { emptyGroup } from "./tree.ts";
import type { EditorLayout, Side, SplitNode } from "./types.ts";

/*
 * Room for groups (spec 5): a split the person asked for shows side by side whenever each group
 * gets enough room to read code; below that the editor asks its panel for more, and only then
 * shows one group at a time.
 */

/**
 * The narrowest a group is worth showing beside another: room for code that wraps at an
 * ordinary width, not a column of fragments.
 */
export const groupMinWidth = 420;
/** The shortest a group is worth showing above or below another. */
export const groupMinHeight = 160;

/** The narrowest a pane gets beside another when the roomy width doesn't fit. */
export const paneLeastWidth = 280;

export interface Room {
  width: number;
  height: number;
}

const roomy: Room = { width: groupMinWidth, height: groupMinHeight };
const tight: Room = { width: paneLeastWidth, height: groupMinHeight };

/**
 * The room the tree needs to show every pane at `pane` (the roomy minimum unless given): rows
 * add widths, columns heights.
 */
export function roomNeeded(node: SplitNode, pane: Room = roomy): Room {
  if (node.kind === "group") return { width: pane.width, height: pane.height };
  const children = node.children.map((child) => roomNeeded(child, pane));
  const sum = (pick: (room: Room) => number) => children.reduce((total, c) => total + pick(c), 0);
  const most = (pick: (room: Room) => number) => Math.max(0, ...children.map(pick));
  return node.direction === "row"
    ? { width: sum((c) => c.width), height: most((c) => c.height) }
    : { width: most((c) => c.width), height: sum((c) => c.height) };
}

/** Every pane fits in `box` at `pane` (a box not measured yet counts as fitting). */
export function groupsFit(node: SplitNode, box: Room, pane: Room = roomy): boolean {
  if (node.kind === "group" || box.width <= 0) return true;
  const needed = roomNeeded(node, pane);
  return box.width >= needed.width && box.height >= needed.height;
}

/**
 * The tree drawn stacked: every row split becomes a column split with the same children and
 * sizes, so a path into it is a path into the stored tree (a resize maps straight back).
 */
export function stacked(node: SplitNode): SplitNode {
  if (node.kind === "group") return node;
  const children = node.children.map(stacked);
  return node.direction === "row" || children.some((child, i) => child !== node.children[i])
    ? { ...node, direction: "column", children }
    : node;
}

/** How the panes show in `box`: the tree to draw and each pane's least size in it. */
export interface PaneDisplay {
  root: SplitNode;
  pane: Room;
}

/**
 * Panes the person made are always on screen (spec 5): side by side at the roomy width, else at
 * `paneLeastWidth`, else stacked (the stored layout is kept, so a wider box shows them side by
 * side again). With no room even stacked they share what there is; a pane is never hidden.
 */
export function displayPanes(node: SplitNode, box: Room): PaneDisplay {
  if (groupsFit(node, box, roomy)) return { root: node, pane: roomy };
  if (groupsFit(node, box, tight)) return { root: node, pane: tight };
  const tall = stacked(node);
  const fitsTall = groupsFit(tall, box, { width: 0, height: groupMinHeight });
  return { root: tall, pane: { width: 0, height: fitsTall ? groupMinHeight : 0 } };
}

const stackedSide = { left: "up", right: "down", up: "up", down: "down" } as const;

/**
 * Where a new pane beside `groupId` goes: `side` while the panes would still fit side by side
 * at `paneLeastWidth` in `room` (the widest the editor can get), else stacked on the same end
 * (right → down, left → up), so the split is always visible.
 */
export function splitSide(layout: EditorLayout, groupId: string, side: Side, room: Room): Side {
  if (side === "up" || side === "down" || room.width <= 0) return side;
  const tried = insertGroup(layout, groupId, side, emptyGroup(`${groupId}~new`));
  return roomNeeded(tried.root, tight).width <= room.width ? side : stackedSide[side];
}
