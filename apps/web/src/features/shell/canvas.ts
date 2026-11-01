/**
 * The canvas: the page surface under the window's top bar. It begins at the sidebar's panel,
 * which turns the 12px corner at its top left (`panelCanvasClass`), and runs on through the main
 * column and any side panel beside it; the rail and the top bar stay on the frame colour. The
 * main column draws one hairline where it meets the panel; with the sidebar hidden or in a sheet
 * it runs to the window's edge and keeps only its top hairline.
 */
export const canvasClass =
  "relative flex min-h-0 min-w-0 flex-1 overflow-clip border-t border-border bg-background [[data-sidebar=shown]_&]:border-l";

/**
 * The sidebar's panel as the start of the canvas, with its rounded corner: a half step apart from
 * the chat (`--sidebar-panel`) so the list and the conversation read as separate areas.
 */
export const panelCanvasClass =
  "overflow-clip rounded-tl-lg border-t border-l border-border bg-(--sidebar-panel)";
