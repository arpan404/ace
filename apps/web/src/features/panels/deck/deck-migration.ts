import {
  migratePanelTabs,
  type EditorLayout,
  type MigratedDraft,
} from "@ace/ui-core/editor-workbench";
import {
  activateTab,
  closeTab,
  findTab,
  moveTab,
  openTab,
  setTabPinned,
  type ScopeWorkspace,
} from "@ace/ui-core/workspace-tabs";
import { deckKind, deckLayoutOf, openInLayout } from "./deck-layout.ts";

/*
 * Spec 55: on first load, a thread's stored Files tab and per-file panel tabs move into its Deck:
 * one group in their order with their preview flags, the Deck tab where the first of them was
 * (pinned if the Files tab was), showing if one of them was. Unsaved drafts ride in the Deck's
 * layout until the Deck has written them to the device's draft store, so nothing is lost even if
 * the page closes first. A pure transform of stored UI state; no daemon migration.
 */

/** The layout field carrying drafts from old file tabs until the draft store has them. */
const draftsField = "migratedDrafts";

/** The workspace with its old file tabs moved into the Deck; the same object when none. */
export function upgradeWorkspace(workspace: ScopeWorkspace): ScopeWorkspace {
  const migration = migratePanelTabs(workspace, "g1");
  if (!migration) return workspace;
  const existing = findTab(workspace, deckKind);
  // A Deck already there (a tab restored from elsewhere) takes the old tabs into its focused
  // group; their drafts join the ones it may still carry.
  const layout = existing
    ? migratedInto(deckLayoutOf(workspace), migration.layout)
    : migration.layout;
  const drafts = [...draftsOf(layout), ...migration.drafts];
  const data: EditorLayout = drafts.length
    ? { ...layout, [draftsField]: drafts }
    : withoutDrafts(layout);
  const pinned = workspace.tabs.some((tab) => migration.replaced.includes(tab.key) && tab.pinned);
  let next = migration.replaced.reduce((each, key) => closeTab(each, key), workspace);
  next = openTab(
    next,
    { kind: deckKind, data, pinned: pinned || existing?.tab.pinned },
    { reveal: false },
  );
  if (!existing) next = moveTab(next, deckKind, migration.index);
  if (pinned) next = setTabPinned(next, deckKind, true);
  // The Deck shows where a file tab showed, with the panel as open or closed as it was.
  return migration.wasActive ? { ...activateTab(next, deckKind), open: workspace.open } : next;
}

function migratedInto(target: EditorLayout, from: EditorLayout): EditorLayout {
  const group = from.root.kind === "group" ? from.root : undefined;
  return (group?.tabs ?? []).reduce(
    (layout, tab) => openInLayout(layout, tab.path, { keep: !tab.preview }),
    target,
  );
}

/** Drafts the layout still carries from old file tabs. */
export function draftsOf(layout: EditorLayout): MigratedDraft[] {
  const value = layout[draftsField];
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => {
    if (typeof each !== "object" || each === null) return [];
    const path: unknown = Reflect.get(each, "path");
    const text: unknown = Reflect.get(each, "text");
    const original: unknown = Reflect.get(each, "original");
    const version: unknown = Reflect.get(each, "version");
    return typeof path === "string" &&
      typeof text === "string" &&
      typeof original === "string" &&
      typeof version === "string"
      ? [{ path, text, original, version }]
      : [];
  });
}

/** The layout once its drafts are in the draft store. */
export function withoutDrafts(layout: EditorLayout): EditorLayout {
  if (!(draftsField in layout)) return layout;
  const { [draftsField]: _drafts, ...rest } = layout;
  return {
    ...rest,
    root: layout.root,
    focused: layout.focused,
    explorer: layout.explorer,
    closed: layout.closed,
  };
}
