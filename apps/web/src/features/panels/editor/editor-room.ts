import { compactBelowPx } from "@/features/editor-workbench/index.ts";

/*
 * The editor panel's room (spec 4–5), pure: where the explorer sits for the panel's width, when
 * "Show files" is the way to it, and how wide the panel should become for a split to show.
 */

/**
 * `docked`: beside the code. `overlay`: laid over the code, closing once a file is picked.
 * `aside`: stepped aside, behind "Show files".
 */
export type ExplorerPlace = "docked" | "overlay" | "aside";

export function explorerPlace(input: {
  /** The panel's measured width. */
  width: number;
  /** The layout's explorer is open (wide layout). */
  open: boolean;
  /** "Show files" laid it out (compact layout). */
  overlay: boolean;
  /** No file is open: nothing to lay it over, so it docks beside the empty state. */
  empty: boolean;
}): ExplorerPlace {
  const compact = input.width > 0 && input.width < compactBelowPx;
  if (!compact) return input.open ? "docked" : "aside";
  if (!input.overlay) return "aside";
  return input.empty ? "docked" : "overlay";
}

/** "Show files" shows while the explorer isn't docked beside the code (and hides an overlay). */
export const showsExplorerToggle = (place: ExplorerPlace): boolean => place !== "docked";

/** The panel's border and the edge between groups: room beyond the groups' own. */
const chromePx = 8;

/**
 * The width to ask the side panel for so every group fits, or undefined when it can't or
 * needn't grow: docked under the column or in full view the room isn't the panel's to ask for.
 * From 760px the explorer docks beside the code, so its width joins the ask.
 */
export function roomAsk(input: {
  /** The editor area's width every group needs (`roomNeeded`). */
  needed: number;
  panel: { size: number; dock: "side" | "bottom"; expanded: boolean };
  explorer: { open: boolean; width: number };
}): number | undefined {
  const { panel, explorer } = input;
  if (panel.dock === "bottom" || panel.expanded) return undefined;
  const bare = input.needed + chromePx;
  const width = bare >= compactBelowPx && explorer.open ? bare + explorer.width : bare;
  return panel.size >= width ? undefined : width;
}
