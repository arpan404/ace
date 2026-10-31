/**
 * The raised canvas: the main column (and the side panel beside it) on the page surface, under
 * the window's top bar. With the sidebar beside it, it turns a 12px corner at its top left and
 * draws the one hairline where it meets the frame; with the sidebar hidden or in a sheet it
 * runs to the window's edge and keeps only its top hairline.
 */
export const canvasClass =
  "relative flex min-h-0 min-w-0 flex-1 overflow-clip border-t border-border bg-background [[data-sidebar=shown]_&]:rounded-tl-lg [[data-sidebar=shown]_&]:border-l";
