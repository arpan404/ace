/**
 * Local echo for the live page: the person's own pointer, shown before
 * the page's next frame. Pure: the shell (`use-local-echo.ts`) owns timers, frames and the DOM.
 */

/** CSS cursor keywords a page may set; anything else is drawn as the default arrow. */
const cursorKeywords = new Set([
  "auto",
  "default",
  "none",
  "context-menu",
  "help",
  "pointer",
  "progress",
  "wait",
  "cell",
  "crosshair",
  "text",
  "vertical-text",
  "alias",
  "copy",
  "move",
  "no-drop",
  "not-allowed",
  "grab",
  "grabbing",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
]);

/**
 * The person's own pointer over the page, drawn by their system at display rate in the page's
 * cursor shape (a CSS keyword the page reported). Unknown or missing shapes are the arrow.
 */
export function localCursor(shape: string | undefined): string {
  const keyword = shape?.trim().toLowerCase();
  if (!keyword || keyword === "auto") return "default";
  return cursorKeywords.has(keyword) ? keyword : "default";
}
