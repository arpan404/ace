import type { WorkspaceTab } from "../workspace-tabs.ts";
import { notYet } from "./stub.ts";
import type { EditorLayout } from "./types.ts";

/** Unsaved text a per-file tab carried; it moves to the draft store. */
export interface MigratedDraft {
  path: string;
  text: string;
  /** The text the person started from. */
  original: string;
  /** The file version the edit is based on. */
  version: string;
}
export interface PanelTabMigration {
  layout: EditorLayout;
  drafts: readonly MigratedDraft[];
  /** Panel tab keys the Deck replaces (the Files tab and every per-file tab). */
  replaced: readonly string[];
  /** The Deck takes the Files tab's place in the strip, or the first file tab's. */
  index: number;
  /** One of the replaced tabs was the active panel tab. */
  wasActive: boolean;
}
/**
 * Spec 55: move a thread's stored Files and per-file panel tabs into one Deck group, in their
 * order, with their preview flags. Undefined when there is nothing to move.
 */
export function migratePanelTabs(
  workspace: { tabs: readonly WorkspaceTab[]; active: string | undefined },
  groupId: string,
): PanelTabMigration | undefined {
  return notYet(`migratePanelTabs ${workspace.tabs.length} ${groupId}`);
}
