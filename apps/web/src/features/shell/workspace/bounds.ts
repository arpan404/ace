/*
 * How big each dock may be. Computed from the room the screen actually has (after the rail and
 * the second sidebar), not from the viewport minus a constant.
 */

export const dockLimits = {
  right: { min: 360, keep: 480 },
  bottom: { min: 160, keep: 240 },
  /** Floating over a narrow window, the right dock leaves this strip of the column visible. */
  overlayStrip: 48,
} as const;

export interface Bounds {
  min: number;
  max: number;
}

/**
 * Right dock: at least 360px, at most what leaves the main column 480px. Floating (narrow
 * windows), it may cover all but a 48px strip.
 */
export function rightBounds(rowWidth: number, overlay: boolean): Bounds {
  const { min, keep } = dockLimits.right;
  if (overlay) {
    const room = Math.max(0, rowWidth - dockLimits.overlayStrip);
    return { min: Math.min(min, room), max: Math.max(Math.min(min, room), room) };
  }
  return { min, max: Math.max(min, rowWidth - keep) };
}

/** Bottom dock: at least 160px, at most what leaves 240px of the screen above it. */
export function bottomBounds(screenHeight: number): Bounds {
  const { min, keep } = dockLimits.bottom;
  return { min, max: Math.max(min, screenHeight - keep) };
}

export function clampToBounds(size: number, bounds: Bounds): number {
  return Math.round(Math.min(Math.max(size, bounds.min), Math.max(bounds.min, bounds.max)));
}
