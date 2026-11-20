/*
 * The Deck's layout shape, as the view reads it: the split tree and the focused group of W1's
 * stored `EditorLayout` (docs/editor/workbench.md, "Decisions"). W1's model in
 * `@ace/ui-core/editor-workbench` owns the full shape and its rules; until it lands on this
 * branch the view declares the part it reads here, and W1's type satisfies it structurally.
 */

export interface DeckTab {
  path: string;
  /** A glance: the next glance in the group replaces it. Shown italic. */
  preview: boolean;
  pinned: boolean;
}

export interface DeckGroup {
  kind: "group";
  id: string;
  tabs: DeckTab[];
  /** The path of the shown tab. */
  active?: string | undefined;
  /** Paths, most recently used first. */
  mru: string[];
}

export interface DeckSplit {
  kind: "split";
  direction: "row" | "column";
  /** One weight per child; the view lays them out in proportion. */
  sizes: number[];
  children: DeckNode[];
}

export type DeckNode = DeckGroup | DeckSplit;

export interface DeckLayout {
  root: DeckNode;
  /** The focused group's id. */
  focused: string;
}

/** Where a split sits in the tree: child indices from the root. */
export type SplitPath = readonly number[];

/** The groups in reading order (left to right, top to bottom): ⌘1 is the first. */
export function deckGroups(node: DeckNode): DeckGroup[] {
  return node.kind === "group" ? [node] : node.children.flatMap(deckGroups);
}

export function findGroup(layout: DeckLayout, id: string): DeckGroup | undefined {
  return deckGroups(layout.root).find((group) => group.id === id);
}

const noGroup: DeckGroup = { kind: "group", id: "", tabs: [], mru: [] };

/** The focused group, or the first one when the stored focus names none. */
export function focusedGroup(layout: DeckLayout): DeckGroup {
  const groups = deckGroups(layout.root);
  return groups.find((group) => group.id === layout.focused) ?? groups[0] ?? noGroup;
}

/** Where a dragged tab lands beside a group: the outer third of that side. */
export type SplitSide = "left" | "right" | "up" | "down";

/** The layout changes the view asks for. W1's model implements them; see `interim-ops.ts`. */
export interface DeckOps {
  focus(layout: DeckLayout, group: string): DeckLayout;
  /** Show a tab already in the group. */
  activate(layout: DeckLayout, group: string, path: string): DeckLayout;
  /** Turn a preview tab into a kept one. */
  keep(layout: DeckLayout, group: string, path: string): DeckLayout;
  setPinned(layout: DeckLayout, group: string, path: string, pinned: boolean): DeckLayout;
  /** Close these tabs of the group; an emptied group closes unless it is the last. */
  close(layout: DeckLayout, group: string, paths: readonly string[]): DeckLayout;
  /** Move a tab into a strip at an index (the same strip reorders). */
  move(
    layout: DeckLayout,
    from: { group: string; path: string },
    to: { group: string; index: number },
  ): DeckLayout;
  /** Put a tab in a new group on one side of `target`; `copy` leaves the original open. */
  split(
    layout: DeckLayout,
    from: { group: string; path: string },
    target: string,
    side: SplitSide,
    copy: boolean,
  ): DeckLayout;
  /** New weights for the split at `at`. */
  resize(layout: DeckLayout, at: SplitPath, sizes: readonly number[]): DeckLayout;
}
