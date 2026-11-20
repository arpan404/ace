import { notYet } from "./stub.ts";
import type { EditorLayout, EditorTab, GroupNode, NewGroupId, TabRef, ViewState } from "./types.ts";

export interface OpenEditorOptions {
  /** `glance` opens or replaces the group's preview tab; `keep` opens a tab that stays. */
  intent: "glance" | "keep";
  /** The group to open in; the focused group when omitted. */
  group?: string | undefined;
  /** Paths with unsaved edits: a preview with unsaved edits is kept, never replaced. */
  unsaved?: ReadonlySet<string> | undefined;
  view?: ViewState | undefined;
}

/** Open a file in a group (spec 9–11): an open tab comes forward, a glance replaces the preview. */
export function openEditor(
  layout: EditorLayout,
  path: string,
  options: OpenEditorOptions,
): EditorLayout {
  return notYet(`openEditor ${path} ${options.intent}`);
}
/** ⌘-click / ⌘↵: open in the group to the right, splitting right when there is none. */
export function openEditorToSide(
  layout: EditorLayout,
  path: string,
  options: OpenEditorOptions,
  newGroupId: NewGroupId,
): EditorLayout {
  return notYet(`openEditorToSide ${path} ${options.intent} ${typeof newGroupId}`);
}
/** Show a tab: its group gains focus and the tab moves to the front of the group's MRU. */
export function activateTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return notYet(`activateTab ${ref.path}`);
}
/** A preview becomes a kept tab (double-click, typing, dragging). */
export function keepTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return notYet(`keepTab ${ref.path}`);
}
export function pinTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return notYet(`pinTab ${ref.path}`);
}
export function unpinTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return notYet(`unpinTab ${ref.path}`);
}
export function setViewState(layout: EditorLayout, ref: TabRef, view: ViewState): EditorLayout {
  return notYet(`setViewState ${ref.path} ${Object.keys(view).length}`);
}
/** The group's tabs in most recently used order (⌃Tab, quick open's empty list). */
export function mruTabs(group: GroupNode): readonly EditorTab[] {
  return notYet(`mruTabs ${group.id}`);
}
/** Every view of a path across the groups, in reading order. */
export function viewsOf(layout: EditorLayout, path: string): readonly TabRef[] {
  return notYet(`viewsOf ${path}`);
}
export interface TabLabel {
  name: string;
  /** The nearest folder that tells two same-named tabs apart; undefined when the name is unique. */
  folder?: string | undefined;
}
/** Names for a strip or a list (spec 20): same names gain their nearest differing folder. */
export function tabLabels(paths: readonly string[]): readonly TabLabel[] {
  return notYet(`tabLabels ${paths.length}`);
}
