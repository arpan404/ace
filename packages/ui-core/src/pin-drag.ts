/*
 * Where a thread dragged in the Home list would land (pointer or keyboard). The Pinned group
 * has places, one between each pair of pinned threads; the rest of the list is in Home order,
 * which the person doesn't set, so it is one target: Unpin. Pure: the caller measures rows.
 */

/** Pin at `index` among the pinned threads not being moved, or leave the Pinned group. */
export type DropTarget = { kind: "pin"; index: number } | { kind: "unpin" };

/** One drawn row, in list coordinates (`top` from the list's top edge). */
export interface RowBox {
  /** `pinned` rows are places; `pin-zone` is the Pinned heading or the empty group's target. */
  kind: "pin-zone" | "pinned" | "other";
  id?: string;
  top: number;
  bottom: number;
}

export function sameTarget(a: DropTarget | undefined, b: DropTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "unpin" || b.kind === "unpin") return a.kind === b.kind;
  return a.index === b.index;
}

/**
 * The target under `y`. Over the Pinned group (its heading down to just past its last row) it
 * is the gap nearest the pointer; below it, Unpin when a moved thread is pinned, else nothing.
 */
export function dropTargetAt(
  boxes: readonly RowBox[],
  y: number,
  moving: ReadonlySet<string>,
): DropTarget | undefined {
  const places = boxes.filter((box) => box.kind === "pinned" && !moving.has(box.id ?? ""));
  const zone = boxes.find((box) => box.kind === "pin-zone");
  const pinnedRows = boxes.filter((box) => box.kind === "pinned");
  const last = pinnedRows.at(-1) ?? zone;
  if (!last) return undefined;
  // A little past the group's end still counts, so the bottom place is easy to hit.
  const end = last.bottom + Math.min(24, (last.bottom - last.top) / 2);
  if (y < end) {
    const index = places.filter((box) => (box.top + box.bottom) / 2 < y).length;
    return { kind: "pin", index };
  }
  const movingPinned = pinnedRows.some((box) => moving.has(box.id ?? ""));
  return movingPinned ? { kind: "unpin" } : undefined;
}

/** Where to draw a target's line, in list coordinates. */
export function indicatorAt(
  boxes: readonly RowBox[],
  target: DropTarget,
  moving: ReadonlySet<string>,
): number {
  if (target.kind === "unpin") {
    const first = boxes.find((box) => box.kind === "other");
    const pinnedEnd = boxes.findLast((box) => box.kind !== "other");
    return first?.top ?? pinnedEnd?.bottom ?? 0;
  }
  const places = boxes.filter((box) => box.kind === "pinned" && !moving.has(box.id ?? ""));
  const at = places[target.index];
  if (at) return at.top;
  const end = places.at(-1) ?? boxes.find((box) => box.kind === "pin-zone");
  return end?.bottom ?? 0;
}

/**
 * The targets a keyboard move steps through, top to bottom: each place in the Pinned group (as
 * many as the pinned threads not moving, plus one), then the rest of the list (Unpin, or for a
 * thread that isn't pinned, staying where it is).
 */
export function moveTargets(otherPinned: number): DropTarget[] {
  const targets: DropTarget[] = Array.from({ length: otherPinned + 1 }, (_, index) => ({
    kind: "pin" as const,
    index,
  }));
  targets.push({ kind: "unpin" });
  return targets;
}

/** The next keyboard target from `current`: `step` is -1 (up) or 1 (down); stops at the ends. */
export function stepTarget(
  targets: readonly DropTarget[],
  current: DropTarget,
  step: number,
): DropTarget {
  const at = targets.findIndex((target) => sameTarget(target, current));
  const next = Math.max(0, Math.min(targets.length - 1, at + step));
  return targets[next] ?? current;
}
