/*
 * Side panel size rules shared by the web app and the tablet apps. The web shares the window's
 * width in `apps/web/src/lib/shell-room.ts`; these are the pieces both use.
 */

/** A side panel's width rules: at least `min` wide, leaving the thread at least `keep`. */
export interface PanelLimits {
  min: number;
  keep: number;
}

export interface Bounds {
  min: number;
  max: number;
}

export function clampToBounds(size: number, bounds: Bounds): number {
  return Math.round(Math.min(Math.max(size, bounds.min), Math.max(bounds.min, bounds.max)));
}

/** How tall the bottom panel may be: six terminal rows at least, and room left for the thread. */
export const bottomLimits = { min: 120, keep: 240 } as const;

/** At least 120px, at most what leaves the conversation (header, transcript, composer) 240px. */
export function bottomBounds(height: number): Bounds {
  const { min, keep } = bottomLimits;
  return { min, max: Math.max(min, height - keep) };
}
