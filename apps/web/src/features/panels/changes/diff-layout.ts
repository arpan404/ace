import type { DiffPrefs } from "../services.ts";

/** Auto layout is split from this diff width, unified below it. */
const splitFrom = 880;
/** The files tree sits beside the diff from this tab width, above it below. */
const treeBesideFrom = 600;
/** The tree's width beside the diff (its `w-[240px]`). */
export const treeWidth = 240;
/** A chosen Split needs this much diff width; narrower it shows unified until there is room. */
const splitNeeds = 640;

export interface DiffLayout {
  /** The files tree shows: asked for, and more than one file to pick from. */
  showTree: boolean;
  /** The tree sits beside the diff rather than above it. */
  beside: boolean;
  /** The layout drawn, after Auto and the room available. */
  mode: "unified" | "split";
  /** Split was chosen but the diff is too narrow for two columns of code. */
  splitTooNarrow: boolean;
}

/** How a Changes tab `width` px wide lays out `files` diffs under the person's preferences. */
export function diffLayout(width: number, prefs: DiffPrefs, files: number): DiffLayout {
  const showTree = prefs.tree && files > 1;
  const beside = width >= treeBesideFrom;
  // Two columns of code at ~200px each clip mid-token: a chosen Split waits for the room (the
  // choice is global, so full view's Split mustn't squeeze every 520px panel). 0 is unmeasured.
  const diffWidth = width - (showTree && beside ? treeWidth : 0);
  const splitTooNarrow = prefs.mode === "split" && width > 0 && diffWidth < splitNeeds;
  const mode =
    prefs.mode === "auto"
      ? width >= splitFrom
        ? "split"
        : "unified"
      : splitTooNarrow
        ? "unified"
        : prefs.mode;
  return { showTree, beside, mode, splitTooNarrow };
}
