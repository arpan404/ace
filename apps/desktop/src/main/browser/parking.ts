/** Offscreen origin for the parking window, where the OS allows it (not macOS: see below). */
export const parkingOrigin = { x: -10_000, y: -10_000 };

/** How the app's parking window is built on one platform. */
export interface ParkingWindow {
  /** Options for `new BaseWindow`. */
  options: ReturnType<typeof transparentOptions> | ReturnType<typeof pinholeOptions>;
  /** Give the window an empty shape (`setShape([])`): nothing of it is drawn or hit. */
  emptyShape: boolean;
  /** The window grows to hold its largest view; a pinhole keeps its one pixel. */
  growsWithViews: boolean;
}

/**
 * The parking window holds browser views no app window shows. It must be shown: a hidden,
 * never-shown or minimized window gets no compositor frames, so `requestAnimationFrame`, CDP
 * screencasts and `capturePage` stall while an agent drives the page.
 *
 * macOS and Windows: a fully transparent window of the views' size, out of the way.
 *
 * Linux window managers ignore opacity (`setOpacity` "does nothing" there) and Wayland ignores
 * positions (`setPosition` is "not supported on Wayland"), so a transparent offscreen window
 * would sit on the person's screen. On Linux it is a one-pixel pinhole: a view larger than its
 * window is clipped, not culled, so it keeps its full size, frames and screenshots. On X11 an
 * empty shape also hides that pixel; Wayland has no window shapes, so one pixel remains.
 */
export function parkingWindow(
  platform: NodeJS.Platform,
  size: { width: number; height: number },
): ParkingWindow {
  if (platform === "linux")
    return { options: pinholeOptions(), emptyShape: true, growsWithViews: false };
  return { options: transparentOptions(size), emptyShape: false, growsWithViews: true };
}

/** Never focused, never in a taskbar, never framed, shadowed or full screen; click-through is the host's. */
const unobtrusive = {
  show: false,
  focusable: false,
  skipTaskbar: true,
  frame: false,
  hasShadow: false,
  fullscreenable: false,
  title: "ace browser",
  x: parkingOrigin.x,
  y: parkingOrigin.y,
} as const;

/**
 * macOS moves a shown window back onto the screen whatever its position, so the window is fully
 * transparent and out of Mission Control: a transparent window still renders at full speed and
 * `capturePage` still sees the page. It can never go full screen: while an app window is full
 * screen, macOS opens any new full-screen-capable window as its own Space.
 */
function transparentOptions(size: { width: number; height: number }) {
  return {
    ...unobtrusive,
    opacity: 0,
    hiddenInMissionControl: true,
    width: size.width,
    height: size.height,
  };
}

/** One pixel that nobody can resize; the views inside keep their own, larger bounds. */
function pinholeOptions() {
  return {
    ...unobtrusive,
    resizable: false,
    width: 1,
    height: 1,
    minWidth: 1,
    minHeight: 1,
  };
}
