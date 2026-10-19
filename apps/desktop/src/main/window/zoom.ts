/**
 * View › Zoom. Electron's own zoom roles act on whichever page has focus, so with a chat
 * visualization (a `<webview>`) or the native browser page focused they zoomed only that page.
 * ace's zoom is the window's: it changes the window's own page, and embedded visualizations
 * follow it (a `<webview>` keeps its embedder's zoom).
 */

export type ZoomChange = "in" | "out" | "reset";

/** Half a Chromium zoom level per step, as Electron's roles take, within Chromium's 25%–500%. */
const step = 0.5;
const lowest = -7.5;
const highest = 8.5;

/** The zoom level after `change`, from `level`. */
function zoomedLevel(level: number, change: ZoomChange): number {
  if (change === "reset" || !Number.isFinite(level)) return 0;
  const next = level + (change === "in" ? step : -step);
  return Math.min(highest, Math.max(lowest, next));
}

/** The page a window's zoom applies to. */
export interface ZoomTarget {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  isDestroyed(): boolean;
}

export function applyZoom(target: ZoomTarget | undefined, change: ZoomChange): void {
  if (!target || target.isDestroyed()) return;
  target.setZoomLevel(zoomedLevel(target.getZoomLevel(), change));
}
