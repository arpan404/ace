import type { SplitNode } from "./types.ts";

/*
 * Room for groups (spec 5): a split the person asked for shows side by side whenever each group
 * gets enough room to read code; below that the editor asks its panel for more, and only then
 * shows one group at a time.
 */

/** The narrowest a group is worth showing beside another. */
export const groupMinWidth = 320;
/** The shortest a group is worth showing above or below another. */
export const groupMinHeight = 160;

export interface Room {
  width: number;
  height: number;
}

/** The room the tree needs to show every group at its minimum: rows add widths, columns heights. */
export function roomNeeded(node: SplitNode): Room {
  if (node.kind === "group") return { width: groupMinWidth, height: groupMinHeight };
  const children = node.children.map(roomNeeded);
  const sum = (pick: (room: Room) => number) => children.reduce((total, c) => total + pick(c), 0);
  const most = (pick: (room: Room) => number) => Math.max(0, ...children.map(pick));
  return node.direction === "row"
    ? { width: sum((c) => c.width), height: most((c) => c.height) }
    : { width: most((c) => c.width), height: sum((c) => c.height) };
}

/** Every group fits side by side in `box` (a box not measured yet counts as fitting). */
export function groupsFit(node: SplitNode, box: Room): boolean {
  if (node.kind === "group" || box.width <= 0) return true;
  const needed = roomNeeded(node);
  return box.width >= needed.width && box.height >= needed.height;
}
