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
import { requestReveal } from "./deck-reveal.ts";

/*
 * The Deck panel tab (docs/editor/workbench.md 8–13, 52): its data is the thread's workbench
 * layout. Every checkout file opens through `openInDeck`, from the explorer, quick open, a search
 * hit, a chat mention or link, the Work card, an artifact, Changes. A glance (a pointer's single
 * click, a mention, a hit) opens the focused group's preview tab and leaves focus where it was;
 * a deliberate open keeps the tab and, with `focus`, puts the keyboard in the editor. Here in
 * the foundation so every opener can reach it; the panel itself is a feature.
 */

/** The Deck's kind, and its singleton tab's key. */
export const deckKind = "deck";

/** The id a layout with no groups yet gives its first group. */
const firstGroup = "g1";

/** The thread's Deck layout: its tab's data read leniently, else one empty group. */
export function deckLayoutOf(workspace: ScopeWorkspace): EditorLayout {
  return parseLayout(findTab(workspace, deckKind)?.tab.data, firstGroup);
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

export interface DeckOpen {
  /** A deliberate open: the tab stays. Else a glance, which the group's next glance replaces. */
  keep?: boolean | undefined;
  /** ⌘-click or ⌘↵: in the group to the right, splitting right when there is none. */
  side?: boolean | undefined;
  /** Paths with unsaved edits: a preview with unsaved edits is kept, never replaced. */
  unsaved?: ReadonlySet<string> | undefined;
}

/** `layout` with `path` open in the focused group (or beside it), by spec 9–11. */
export function openInLayout(layout: EditorLayout, path: string, options: DeckOpen): EditorLayout {
  const open = {
    intent: options.keep ? ("keep" as const) : ("glance" as const),
    unsaved: options.unsaved,
  };
  return options.side
    ? openEditorToSide(layout, path, open, groupIds(layout))
    : openEditor(layout, path, open);
}

export interface OpenInDeckOptions extends Omit<DeckOpen, "unsaved"> {
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
export interface DeckTarget {
  scope: string;
  /** The workspace as it is now: read at the moment of the open, never a stale render's copy. */
  read(): ScopeWorkspace;
  actions: WorkspaceActions;
  /** The width a panel without its own size starts at, now. */
  preferred?: (() => number) | undefined;
}

/** Spec 4: the width the Deck asks for when a file opens in a narrower docked panel. */
export const deckRoom = 640;

function showDeck(target: DeckTarget, next: EditorLayout): void {
  const workspace = target.read();
  const showing =
    workspace.open &&
    findTab(workspace, deckKind) !== undefined &&
    shownTab(workspace)?.key === deckKind;
  target.actions.open({ kind: deckKind, data: next });
  // Asked once per opening of the Deck, never while it already shows (a tab switch, the next
  // file): a width the person dragged since is kept.
  if (!showing && workspace.dock !== "bottom" && !workspace.expanded) {
    const width = workspace.size ?? target.preferred?.() ?? deckRoom;
    if (width < deckRoom) target.actions.setSize(deckRoom, true);
  }
}

/** Open a checkout file in the thread's Deck. */
export function openInDeck(target: DeckTarget, path: string, options: OpenInDeckOptions = {}) {
  const next = openInLayout(deckLayoutOf(target.read()), path, options);
  showDeck(target, next);
  requestReveal(target.scope, {
    path,
    group: focusedGroup(next).id,
    line: options.line,
    column: options.line === undefined ? undefined : (options.column ?? 0),
    length: options.length,
    focus: options.focus ?? false,
  });
}

/** Show the Deck's explorer filtered to `query` (a name several checkout files share). */
export function findInDeck(target: DeckTarget, query: string) {
  const layout = deckLayoutOf(target.read());
  showDeck(target, {
    ...layout,
    explorer: { ...layout.explorer, open: true, side: "files", query },
  });
}
