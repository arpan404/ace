import type { SplitSide } from "./layout.ts";

/** Where a tab dropped over a group's editor lands: into the group, or a new group on a side. */
export type DropZone = "center" | SplitSide;

/**
 * Spec 16: the middle third moves the tab into the group; an outer third makes a new group on
 * that side. Corners go to the side the point is proportionally nearer to.
 */
export function dropZone(
  point: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
): DropZone {
  if (box.width <= 0 || box.height <= 0) return "center";
  const fx = (point.x - box.left) / box.width;
  const fy = (point.y - box.top) / box.height;
  const edges: [SplitSide, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  const [side, distance] = edges.reduce((near, each) => (each[1] < near[1] ? each : near));
  return distance < 1 / 3 ? side : "center";
}
