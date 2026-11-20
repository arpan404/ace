export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The popover's width, and the room it keeps from the icon and the screen's edges. */
export const popoverWidth = 360;
const gap = 6;
const margin = 8;

/**
 * Where the menu-bar popover opens: centred under its icon (or over it, for a taskbar at the
 * bottom of the screen), kept inside the display's work area, and never taller than it.
 */
export function popoverBounds(icon: Box, area: Box, height: number): Box {
  const width = Math.min(popoverWidth, area.width - margin * 2);
  const tall = Math.max(1, Math.min(Math.round(height), area.height - margin * 2));
  const centre = icon.x + icon.width / 2;
  const left = area.x + margin;
  const right = area.x + area.width - margin - width;
  const x = Math.round(Math.min(Math.max(centre - width / 2, left), right));
  // An icon in the top half (the macOS menu bar, a top panel) opens down; else up.
  const below = icon.y + icon.height / 2 < area.y + area.height / 2;
  const y = below
    ? Math.max(icon.y + icon.height, area.y) + gap
    : Math.min(icon.y, area.y + area.height) - gap - tall;
  return { x, y: Math.round(y), width, height: tall };
}

/**
 * A click on the icon while the popover is open first takes focus from it, which hides it;
 * that same click must not open it again. A click this soon after a hide is that click.
 */
export function reopensOnClick(hiddenAt: number | undefined, now: number): boolean {
  return hiddenAt === undefined || now - hiddenAt > 250;
}
