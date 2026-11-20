import { notYet } from "./stub.ts";
import type { EditorLayout, TabRef } from "./types.ts";

/** The tab menu's close variants (spec 24). `all` is the whole group of the tab. */
export type CloseWhich = "others" | "right" | "saved" | "all";

/** The tabs a close variant would close, around `ref` in its group. Pinned tabs are skipped by all but `all`. */
export function tabsToClose(
  layout: EditorLayout,
  ref: TabRef,
  which: CloseWhich,
  unsaved: ReadonlySet<string>,
): readonly TabRef[] {
  return notYet(`tabsToClose ${ref.path} ${which} ${unsaved.size}`);
}
export interface CloseResult {
  layout: EditorLayout;
  /** Tabs left open because closing them would lose unsaved text: ask, then `discardTabs`. */
  asking: readonly TabRef[];
}
/** Close tabs; the last view of an unsaved file stays open and is returned to ask about. */
export function closeTabs(
  layout: EditorLayout,
  refs: readonly TabRef[],
  unsaved: ReadonlySet<string>,
): CloseResult {
  return notYet(`closeTabs ${refs.length} ${unsaved.size}`);
}
/** Close tabs after the person answered (Save or Don't save). */
export function discardTabs(layout: EditorLayout, refs: readonly TabRef[]): EditorLayout {
  return notYet(`discardTabs ${refs.length}`);
}
/** Reopen the last closed editor in its group at its index, with its view state. */
export function reopenClosed(layout: EditorLayout): EditorLayout {
  return notYet(`reopenClosed ${layout.closed.length}`);
}
