/*
 * How the window's width is shared between the sidebar, the main column and the side panel.
 * Pure: the window's width, the sidebar's state and the remembered widths in; where each part
 * goes and how wide it is out. The panel always docks: beside the column, under it, or (on a
 * phone-sized window, where both can't fit) in the column's place. Nothing floats over the chat.
 */

export const roomLimits = {
  /** Below this window width the side panel takes the canvas in the column's place. */
  phone: 640,
  /** At and below this window width an open side panel steps the sidebar aside. */
  crowded: 1100,
  /** The side panel narrows towards this before the main column gives anything up. */
  panelMin: 320,
  /** The main column never gets narrower than this beside the panel. */
  mainMin: 360,
} as const;

/**
 * `beside`: docked right of the column, strip in the top bar. `bottom`: docked under the column.
 * `full`: full view, the panel takes the canvas. `replace`: a phone-sized window, where the
 * panel takes the canvas in the column's place, with a way back to the chat.
 */
export type PanelMode = "closed" | "beside" | "bottom" | "full" | "replace";

/** `sheet`: the window is too narrow for the sidebar beside the content at all. */
export type SidebarPlace = "shown" | "yielded" | "hidden" | "sheet";

export interface RoomInput {
  /** The window's width in CSS pixels. */
  window: number;
  sidebar: {
    /** The person's own choice: the sidebar is meant to be on screen. */
    open: boolean;
    /** The window lets the sidebar sit beside the content (otherwise it is a sheet). */
    inline: boolean;
    /** Its width beside the content, rail included. */
    width: number;
  };
  panel: {
    open: boolean;
    dock: "side" | "bottom";
    expanded: boolean;
    /** The width the person last dragged it to (or the preferred one), unclamped. */
    size: number;
  };
}

export interface Room {
  mode: PanelMode;
  sidebar: SidebarPlace;
  /** The side panel's width: beside the column, its drawn width; in the canvas, all of it. */
  panel: number;
  /** How far the panel's edge may be dragged right now (beside the column). */
  bounds: { min: number; max: number };
  /** What the main column keeps. */
  main: number;
}

function panelMode(input: RoomInput): PanelMode {
  const { panel } = input;
  if (!panel.open) return "closed";
  if (panel.dock === "side" && input.window < roomLimits.phone) return "replace";
  if (panel.expanded) return "full";
  return panel.dock === "bottom" ? "bottom" : "beside";
}

function sidebarPlace(input: RoomInput, mode: PanelMode): SidebarPlace {
  const { sidebar } = input;
  if (!sidebar.inline) return "sheet";
  if (!sidebar.open) return "hidden";
  // A side panel takes the sidebar's room first on a crowded window, or whenever the sidebar
  // would leave the column and the panel less than their minimums. This never depends on the
  // panel's own width, so dragging the panel never flips the sidebar.
  const tools = mode === "beside" || mode === "full";
  const tight =
    input.window <= roomLimits.crowded ||
    input.window - sidebar.width < roomLimits.mainMin + roomLimits.panelMin;
  return tools && tight ? "yielded" : "shown";
}

export function allocateRoom(input: RoomInput): Room {
  const mode = panelMode(input);
  const sidebar = sidebarPlace(input, mode);
  const row = Math.max(0, input.window - (sidebar === "shown" ? input.sidebar.width : 0));
  if (mode !== "beside") {
    const canvas = mode === "full" || mode === "replace";
    return {
      mode,
      sidebar,
      panel: canvas ? row : 0,
      bounds: { min: 0, max: 0 },
      main: canvas ? 0 : row,
    };
  }
  // The column keeps its minimum; the panel caps itself rather than covering the column.
  const max = Math.max(0, row - roomLimits.mainMin);
  const min = Math.min(roomLimits.panelMin, max);
  const panel = Math.round(Math.min(Math.max(input.panel.size, min), max));
  return { mode, sidebar, panel, bounds: { min, max }, main: row - panel };
}
