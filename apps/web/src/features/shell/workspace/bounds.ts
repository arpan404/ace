/*
 * How wide the side panel may be. Computed from the room the screen actually has (after the
 * sidebar), not from the viewport minus a constant.
 */

export const panelLimits = {
  min: 360,
  /** The main column keeps at least this much beside the panel. */
  keep: 480,
  /** Floating over a narrow window, the panel leaves this strip of the column visible. */
  overlayStrip: 48,
} as const;

export interface Bounds {
  min: number;
  max: number;
}

/**
 * At least 360px, at most what leaves the main column 480px. Floating (narrow windows), it may
 * cover all but a 48px strip.
 */
export function panelBounds(rowWidth: number, overlay: boolean): Bounds {
  const { min, keep, overlayStrip } = panelLimits;
  if (overlay) {
    const room = Math.max(0, rowWidth - overlayStrip);
    return { min: Math.min(min, room), max: Math.max(Math.min(min, room), room) };
  }
  return { min, max: Math.max(min, rowWidth - keep) };
}

export function clampToBounds(size: number, bounds: Bounds): number {
  return Math.round(Math.min(Math.max(size, bounds.min), Math.max(bounds.min, bounds.max)));
}

/** Crowded desktop windows yield their sidebar to tools before the row measurement updates. */
export function panelFloats(rowWidth: number, viewportOverlay: boolean, crowded: boolean): boolean {
  return viewportOverlay || (!crowded && rowWidth < panelLimits.min + panelLimits.keep);
}
