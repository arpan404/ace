import { notYet } from "./stub.ts";
import type { EditorLayout, GroupNode, NewGroupId, NodePath, Side } from "./types.ts";

/** A Deck with one empty group, focused. */
export function emptyLayout(groupId: string): EditorLayout {
  return notYet(`emptyLayout ${groupId}`);
}
/** Every group in reading order (depth-first): Group 1, Group 2… */
export function groupsOf(layout: EditorLayout): readonly GroupNode[] {
  return notYet(`groupsOf ${layout.focused}`);
}
export function findGroup(layout: EditorLayout, id: string): GroupNode | undefined {
  return notYet(`findGroup ${id}`);
}
export function focusedGroup(layout: EditorLayout): GroupNode {
  return notYet(`focusedGroup ${layout.focused}`);
}
export function focusGroup(layout: EditorLayout, id: string): EditorLayout {
  return notYet(`focusGroup ${id}`);
}
/** ⌘1–⌘9: focus the group at this 1-based reading-order position; past the last, nothing. */
export function focusGroupAt(layout: EditorLayout, ordinal: number): EditorLayout {
  return notYet(`focusGroupAt ${ordinal}`);
}
/** Split right/down (and left/up): a second view of the group's active editor in a new group. */
export function splitGroup(
  layout: EditorLayout,
  groupId: string,
  side: Side,
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`splitGroup ${groupId} ${side} ${typeof newGroupId}`);
}
/** Remove a group; its neighbour takes its room. The last group never goes. */
export function removeGroup(layout: EditorLayout, groupId: string): EditorLayout {
  return notYet(`removeGroup ${groupId}`);
}
/** The group beside this one on that side, if any. */
export function adjacentGroup(
  layout: EditorLayout,
  groupId: string,
  side: Side,
): GroupNode | undefined {
  return notYet(`adjacentGroup ${groupId} ${side}`);
}
/** Drag a split edge: new fractions for the split at `at`, normalised. */
export function resizeSplit(
  layout: EditorLayout,
  at: NodePath,
  sizes: readonly number[],
): EditorLayout {
  return notYet(`resizeSplit ${at.join(".")} ${sizes.length}`);
}
/** Double-click a split edge: even sizes for the split at `at`. */
export function evenSplit(layout: EditorLayout, at: NodePath): EditorLayout {
  return notYet(`evenSplit ${at.join(".")}`);
}
