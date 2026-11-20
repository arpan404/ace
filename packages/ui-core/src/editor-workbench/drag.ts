import { notYet } from "./stub.ts";
import type { EditorLayout, NewGroupId, Side, TabRef } from "./types.ts";

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
  return notYet(`dropZone ${point.x} ${box.width}`);
}
/** Over a strip: the insertion index for a pointer at `x`, from the tabs' boxes. */
export function stripIndex(tabs: readonly { left: number; width: number }[], x: number): number {
  return notYet(`stripIndex ${tabs.length} ${x}`);
}
/** Drag a tab: it moves (kept) and a group emptied by the move closes unless it is the last. */
export function moveTab(
  layout: EditorLayout,
  from: TabRef,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`moveTab ${from.path} ${target.kind} ${typeof newGroupId}`);
}
/** ⌥-drag: a second view at the target; the original stays. */
export function copyTab(
  layout: EditorLayout,
  from: TabRef,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`copyTab ${from.path} ${target.kind} ${typeof newGroupId}`);
}
/** A file dragged from the explorer opens at the target, kept. */
export function dropFile(
  layout: EditorLayout,
  path: string,
  target: DropTarget,
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`dropFile ${path} ${target.kind} ${typeof newGroupId}`);
}
/** ⌃⌘← / ⌃⌘→: move the focused group's active editor to the previous or next group. */
export function moveActiveEditor(
  layout: EditorLayout,
  toward: "previous" | "next",
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`moveActiveEditor ${toward} ${typeof newGroupId}`);
}
