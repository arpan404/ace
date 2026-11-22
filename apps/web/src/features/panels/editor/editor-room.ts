/*
 * The editor panel's room (spec 4–5), pure: how wide the explorer docks for the panel's width,
 * and how wide the panel should become for a split to show. The explorer never lies over the
 * code: it docks beside it whenever it shows, in every layout, and the person hides it (Hide
 * files, ⌘B) when the code wants the whole panel.
 */

/** The code's room beside a docked explorer, kept while the explorer can still narrow. */
export const editorLeastPx = 320;
/** The explorer's least width beside the code. */
export const explorerLeastPx = 160;

/**
 * The docked explorer's width in a panel `panel` px wide: its own (`stored`) while the code keeps
 * `editorLeastPx`, else narrower down to `explorerLeastPx`. Unmeasured (0), its own.
 */
export function explorerWidth(panel: number, stored: number): number {
  if (panel <= 0) return stored;
  return Math.round(Math.min(stored, Math.max(explorerLeastPx, panel - editorLeastPx)));
}

/** The panel's border and the edge between groups: room beyond the groups' own. */
const chromePx = 8;

/**
 * The width to ask the side panel for so every group fits, or undefined when it can't or
 * needn't grow: docked under the column or in full view the room isn't the panel's to ask for.
 * A shown explorer docks beside the code, so its width joins the ask.
 */
export function roomAsk(input: {
  /** The editor area's width every group needs (`roomNeeded`). */
  needed: number;
  panel: {
    size: number;
    dock: "side" | "bottom";
    expanded: boolean;
    /** The widest the panel can be beside the chat now; past it an ask can't be met. */
    max: number;
  };
  explorer: { open: boolean; width: number };
}): number | undefined {
  const { panel, explorer } = input;
  if (panel.dock === "bottom" || panel.expanded) return undefined;
  const bare = input.needed + chromePx;
  const width = explorer.open ? bare + explorer.width : bare;
  // A panel that can't reach the width would only crowd the chat: the switcher shows instead.
  return panel.size >= width || width > panel.max ? undefined : width;
}
