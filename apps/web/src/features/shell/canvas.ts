/**
 * The canvas: the page surface under the window's top bar. It begins at the sidebar's panel,
 * which turns the 12px corner at its top left (`panelCanvasClass`), and runs on through the main
 * column and any side panel beside it; the rail and the top bar stay on the frame colour. The
 * main column draws one hairline where it meets the panel; with the sidebar hidden or in a sheet
 * it runs to the window's edge and keeps only its top hairline. A side panel docked beside the
 * column runs the window's height, its strip in the top bar, and its body carries the canvas on
 * with the same top hairline. Over a Suit's scene the canvas lets `--suit-transcript-reveal`
 * of it through (theme/suits/suit-layers.ts), and the panel `--suit-sidebar-reveal`.
 */
export const canvasClass =
  "relative flex min-h-0 min-w-0 flex-1 overflow-clip border-t border-border bg-background [[data-sidebar=shown]_&]:border-l [[data-layout-sidebar=right]_[data-sidebar=shown]_&]:border-l-0 [[data-layout-sidebar=right]_[data-sidebar=shown]_&]:border-r [[data-suit-scene]_&]:bg-[color:color-mix(in_oklab,var(--background)_calc(100%_-_var(--suit-transcript-reveal,0.3)*100%),transparent)]";

/**
 * The sidebar's panel as the start of the canvas, with its rounded corner: darker than
 * the chat (`--sidebar-panel`), so the list and the conversation read as separate areas.
 */
export const panelCanvasClass =
  "overflow-clip rounded-tl-lg border-t border-l border-border bg-(--sidebar-panel) [[data-layout-sidebar=right]_&]:rounded-tl-none [[data-layout-sidebar=right]_&]:rounded-tr-lg [[data-layout-sidebar=right]_&]:border-l-0 [[data-layout-sidebar=right]_&]:border-r [[data-suit-scene]_&]:bg-[color:color-mix(in_oklab,var(--sidebar-panel)_calc(100%_-_var(--suit-sidebar-reveal,0)*100%),transparent)]";
