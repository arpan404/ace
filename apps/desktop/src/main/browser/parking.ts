/** Offscreen origin for the parking window, where the OS allows it (not macOS: see below). */
export const parkingOrigin = { x: -10_000, y: -10_000 };

/**
 * Options for the parking window, which holds browser views no app window shows. It must be
 * shown: a hidden or fully offscreen window gets no compositor frames, so `requestAnimationFrame`
 * and `startViewTransition` stall while an agent drives the page. macOS moves a shown window back
 * onto the screen whatever its position, so the window is also fully transparent, shadowless,
 * click-through (set by the host) and out of Mission Control: a transparent window still renders
 * at full speed and `capturePage` still sees the page. It can never go full screen: while an app
 * window is full screen, macOS opens any new full-screen-capable window as its own Space. Idle
 * views leave it for `hidden` (throttled, no frames) so the CPU cost rests only on work in progress.
 */
export function parkingWindowOptions(size: { width: number; height: number }) {
  return {
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    opacity: 0,
    hasShadow: false,
    hiddenInMissionControl: true,
    fullscreenable: false,
    title: "ace browser",
    width: size.width,
    height: size.height,
    x: parkingOrigin.x,
    y: parkingOrigin.y,
  };
}
