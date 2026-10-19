/** Offscreen origin for the parking window: shown to the compositor, never to the person. */
export const parkingOrigin = { x: -10_000, y: -10_000 };

/**
 * Options for the parking window. The window is created hidden here and then shown offscreen
 * (`showInactive` in the host): a window that stays hidden produces no compositor frames, so
 * `requestAnimationFrame` and `startViewTransition` stall even though `document.visibilityState`
 * reports "visible" (background throttling is off for parked views). Offscreen it renders at
 * full speed while an agent drives it and never takes focus; idle views leave it for `hidden`
 * (throttled, no frames) so the CPU cost rests only on work in progress.
 */
export function parkingWindowOptions(size: { width: number; height: number }) {
  return {
    show: false,
    focusable: false,
    skipTaskbar: true,
    title: "ace browser",
    width: size.width,
    height: size.height,
    x: parkingOrigin.x,
    y: parkingOrigin.y,
  };
}
