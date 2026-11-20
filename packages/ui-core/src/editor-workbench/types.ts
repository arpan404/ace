/*
 * The Deck's stored shape (docs/editor/workbench.md, "Decisions"): a split tree of editor groups,
 * the focused group, the explorer's state and the closed-editor stack. Local UI state of one
 * thread, kept with the workspace store on the device.
 *
 * Every object may carry fields a newer build wrote; the model keeps them through every
 * operation (it spreads, never rebuilds) and the parser keeps them through a reload.
 */

/** Where the view was: plain data, kept while the buffer is freed (spec 57). */
export interface ViewState {
  /** The first visible line and the pixel offset into it (a scroll anchor, not a position). */
  anchor?: { line: number; offset: number } | undefined;
  /** Selections as offsets into the text; the first is the primary caret. */
  selections?: readonly { anchor: number; head: number }[] | undefined;
  /** Start lines of folded regions. */
  folds?: readonly number[] | undefined;
  readonly [extra: string]: unknown;
}

/** One open editor in a group's strip. A path is open at most once per group. */
export interface EditorTab {
  /** Checkout-relative path. */
  path: string;
  /** A glance: the group's next glance replaces it. At most one per group. */
  preview: boolean;
  /** Pinned tabs sit first in pin order; close others / to the right skip them. */
  pinned: boolean;
  view?: ViewState | undefined;
  readonly [extra: string]: unknown;
}

export interface GroupNode {
  kind: "group";
  id: string;
  tabs: readonly EditorTab[];
  /** The active tab's path; undefined only when `tabs` is empty. */
  active?: string | undefined;
  /** Paths, most recently active first. Every open path appears once. */
  mru: readonly string[];
  readonly [extra: string]: unknown;
}

export interface SplitBranch {
  kind: "split";
  /** `row` lays children left to right, `column` top to bottom. */
  direction: "row" | "column";
  /** Fractions of the split's room, one per child, summing to 1. */
  sizes: readonly number[];
  /** Two or more children; a split never directly holds a split of its own direction. */
  children: readonly SplitNode[];
  readonly [extra: string]: unknown;
}

export type SplitNode = GroupNode | SplitBranch;

export interface ExplorerState {
  open: boolean;
  width: number;
  side: "files" | "search";
  expanded: readonly string[];
  scroll: number;
  query: string;
  /** The Open editors section is unfolded. */
  openEditors: boolean;
  readonly [extra: string]: unknown;
}

/** A closed editor, for Reopen closed: where it was and how it looked. */
export interface ClosedEditor {
  group: string;
  index: number;
  tab: EditorTab;
  readonly [extra: string]: unknown;
}

export interface EditorLayout {
  root: SplitNode;
  /** The focused group's id. */
  focused: string;
  explorer: ExplorerState;
  /** Most recently closed first, at most `limits.closed`. */
  closed: readonly ClosedEditor[];
  readonly [extra: string]: unknown;
}

/** One tab by its group and path. */
export interface TabRef {
  group: string;
  path: string;
}

/** A child's position from the root: child indexes through splits. `[]` is the root. */
export type NodePath = readonly number[];

/** Ids for groups the model creates, injected so tests and stores stay deterministic. */
export type NewGroupId = () => string;

export type Side = "left" | "right" | "up" | "down";

export const limits = {
  /** Groups in one Deck (spec 15). */
  groups: 9,
  /** Closed editors kept for Reopen closed (spec 25). */
  closed: 20,
  /** Tabs stored per thread (spec 52). */
  storedTabs: 100,
} as const;

export const defaultExplorer: ExplorerState = {
  open: true,
  width: 236,
  side: "files",
  expanded: [],
  scroll: 0,
  query: "",
  openEditors: true,
};
