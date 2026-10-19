/*
 * Where a thread dragged in the Home list would land (pointer or keyboard). The Pinned group
 * has places, one between each pair of pinned threads. When the person orders the list by hand,
 * the threads below Pinned (`listed` rows) have places too; otherwise that part follows an
 * order the person doesn't set, so it is one target: Unpin. Pure: the caller measures rows.
 */

/**
 * Pin at `index` among the pinned threads not being moved, place at `index` among the listed
 * threads not being moved (a hand-ordered list), or leave the Pinned group.
 */
export type DropTarget =
  | { kind: "pin"; index: number }
  | { kind: "place"; index: number }
  | { kind: "unpin" };

/** One drawn row, in list coordinates (`top` from the list's top edge). */
export interface RowBox {
  /**
   * `pinned` rows are places; `pin-zone` is the Pinned heading or the empty group's target;
   * `listed` rows are places below Pinned in a hand-ordered list; `other` rows are not places.
   */
  kind: "pin-zone" | "pinned" | "listed" | "other";
  id?: string;
  top: number;
  bottom: number;
}

export function sameTarget(a: DropTarget | undefined, b: DropTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "unpin" || b.kind === "unpin") return true;
  return a.index === b.index;
}

/** The gap nearest `y` among `places`, from the top. */
const gapAt = (places: readonly RowBox[], y: number) =>
  places.filter((box) => (box.top + box.bottom) / 2 < y).length;

/** A little past a group's end still counts, so its bottom place is easy to hit. */
const endOf = (last: RowBox) => last.bottom + Math.min(24, (last.bottom - last.top) / 2);

/**
 * The target under `y`. Over the Pinned group (its heading down to just past its last row) it
 * is the gap nearest the pointer; over listed rows, the gap nearest the pointer there; past
 * both, Unpin when a moved thread is pinned, else nothing.
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
  const listed = boxes.filter((box) => box.kind === "listed");
  // The group's slack stops where listed places begin.
  if (last && y < Math.min(endOf(last), listed[0]?.top ?? Infinity))
    return { kind: "pin", index: gapAt(places, y) };
  const lastListed = listed.at(-1);
  if (lastListed && y < endOf(lastListed))
    return {
      kind: "place",
      index: gapAt(
        listed.filter((box) => !moving.has(box.id ?? "")),
        y,
      ),
    };
  if (!last) return undefined;
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
    const first = boxes.find((box) => box.kind === "other" || box.kind === "listed");
    const pinnedEnd = boxes.findLast((box) => box.kind === "pinned" || box.kind === "pin-zone");
    return first?.top ?? pinnedEnd?.bottom ?? 0;
  }
  if (target.kind === "place") {
    const listed = boxes.filter((box) => box.kind === "listed");
    const places = listed.filter((box) => !moving.has(box.id ?? ""));
    const at = places[target.index];
    if (at) return at.top;
    return places.at(-1)?.bottom ?? listed[0]?.top ?? 0;
  }
  const places = boxes.filter((box) => box.kind === "pinned" && !moving.has(box.id ?? ""));
  const at = places[target.index];
  if (at) return at.top;
  const end = places.at(-1) ?? boxes.find((box) => box.kind === "pin-zone");
  return end?.bottom ?? 0;
}

/**
 * The targets a keyboard move steps through, top to bottom: each place in the Pinned group (as
 * many as the pinned threads not moving, plus one), then the rest of the list: each place among
 * the listed threads not moving when the list is ordered by hand (`otherListed`), else one
 * target (Unpin, or for a thread that isn't pinned, staying where it is).
 */
export function moveTargets(otherPinned: number, otherListed?: number): DropTarget[] {
  const targets: DropTarget[] = Array.from({ length: otherPinned + 1 }, (_, index) => ({
    kind: "pin" as const,
    index,
  }));
  if (otherListed === undefined) targets.push({ kind: "unpin" });
  else for (let index = 0; index <= otherListed; index++) targets.push({ kind: "place", index });
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
