import {
  focusedGroup,
  groupsOf,
  openEditor,
  openEditorToSide,
  parseLayout,
  type EditorLayout,
  type NewGroupId,
} from "@ace/ui-core/editor-workbench";
import { findTab, shownTab, type ScopeWorkspace } from "@ace/ui-core/workspace-tabs";
import type { WorkspaceActions } from "./actions.ts";
import { requestExplorer } from "./editor-explorer-ask.ts";
import { requestReveal } from "./editor-reveal.ts";

/*
 * The editor panel tab (docs/editor/workbench.md 8–13, 52): its data is the thread's workbench
 * layout. Every checkout file opens through `openInEditorPanel`, from the explorer, quick open, a search
 * hit, a chat mention or link, the Work card, an artifact, Changes. A glance (a pointer's single
 * click, a mention, a hit) opens the focused group's preview tab and leaves focus where it was;
 * a deliberate open keeps the tab and, with `focus`, puts the keyboard in the editor. Here in
 * the foundation so every opener can reach it; the panel itself is a feature.
 */

/** The editor's kind, and its singleton tab's key. */
export const editorKind = "editor";

/** The id a layout with no groups yet gives its first group. */
const firstGroup = "g1";

/** The thread's editor layout: its tab's data read leniently, else one empty group. */
export function editorLayoutOf(workspace: ScopeWorkspace): EditorLayout {
  return parseLayout(findTab(workspace, editorKind)?.tab.data, firstGroup);
}

/** Ids for new groups that no group (or closed editor) of `layout` uses yet: g2, g3, … */
export function groupIds(layout: EditorLayout): NewGroupId {
  const taken = new Set([
    ...groupsOf(layout).map((group) => group.id),
    ...layout.closed.map((closed) => closed.group),
  ]);
  let next = 1;
  return () => {
    while (taken.has(`g${next}`)) next++;
    const id = `g${next}`;
    taken.add(id);
    return id;
  };
}

export interface EditorOpen {
  /** A deliberate open: the tab stays. Else a glance, which the group's next glance replaces. */
  keep?: boolean | undefined;
  /** ⌘-click or ⌘↵: in the group to the right, splitting right when there is none. */
  side?: boolean | undefined;
  /** Paths with unsaved edits: a preview with unsaved edits is kept, never replaced. */
  unsaved?: ReadonlySet<string> | undefined;
}

/** `layout` with `path` open in the focused group (or beside it), by spec 9–11. */
export function openInLayout(
  layout: EditorLayout,
  path: string,
  options: EditorOpen,
): EditorLayout {
  const open = {
    intent: options.keep ? ("keep" as const) : ("glance" as const),
    unsaved: options.unsaved,
  };
  return options.side
    ? openEditorToSide(layout, path, open, groupIds(layout))
    : openEditor(layout, path, open);
}

export interface OpenInEditorPanelOptions extends Omit<EditorOpen, "unsaved"> {
  /** 1-based line to reveal centred, with the caret at `column`. */
  line?: number | undefined;
  /** 0-based UTF-16 column on `line`. */
  column?: number | undefined;
  /** With `column`, select this many code units (a search match). */
  length?: number | undefined;
  /** Move the keyboard into the editor once it shows (a keyboard or deliberate open). */
  focus?: boolean | undefined;
}

/** A thread's side panel, as an opener reaches it. */
export interface EditorPanelTarget {
  scope: string;
  /** The workspace as it is now: read at the moment of the open, never a stale render's copy. */
  read(): ScopeWorkspace;
  actions: WorkspaceActions;
  /** The width a panel without its own size starts at, now. */
  preferred?: (() => number) | undefined;
}

/** Spec 4: the width the editor asks for when a file opens in a narrower docked panel. */
export const editorRoom = 640;

function showEditor(target: EditorPanelTarget, next: EditorLayout): void {
  const workspace = target.read();
  const showing =
    workspace.open &&
    findTab(workspace, editorKind) !== undefined &&
    shownTab(workspace)?.key === editorKind;
  target.actions.open({ kind: editorKind, data: next });
  // Asked once per opening of the editor, never while it already shows (a tab switch, the next
  // file): a width the person dragged since is kept.
  if (!showing && workspace.dock !== "bottom" && !workspace.expanded) {
    const width = workspace.size ?? target.preferred?.() ?? editorRoom;
    if (width < editorRoom) target.actions.setSize(editorRoom, true);
  }
}

/** Open a checkout file in the thread's editor. */
export function openInEditorPanel(
  target: EditorPanelTarget,
  path: string,
  options: OpenInEditorPanelOptions = {},
) {
  const next = openInLayout(editorLayoutOf(target.read()), path, options);
  showEditor(target, next);
  requestReveal(target.scope, {
    path,
    group: focusedGroup(next).id,
    line: options.line,
    column: options.line === undefined ? undefined : (options.column ?? 0),
    length: options.length,
    focus: options.focus ?? false,
  });
}

/** Show the editor's explorer filtered to `query` (a name several checkout files share). */
export function findInEditor(target: EditorPanelTarget, query: string) {
  const layout = editorLayoutOf(target.read());
  showEditor(target, {
    ...layout,
    explorer: { ...layout.explorer, open: true, side: "files", query },
  });
  // A compact editor's overlay isn't in the layout: it hears this instead.
  requestExplorer(target.scope);
}
