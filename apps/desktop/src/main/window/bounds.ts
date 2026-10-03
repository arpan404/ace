import { z } from "zod";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SavedWindow = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  maximized: z.boolean().default(false),
  fullScreen: z.boolean().default(false),
});
export type SavedWindow = z.infer<typeof SavedWindow>;

export const minimumSize = { width: 760, height: 520 } as const;
const preferred = { width: 1440, height: 920 } as const;

/**
 * Where to open the window. A saved position is kept only if enough of it is still on a
 * connected display (monitors come and go); otherwise the window is centred on the primary
 * display's work area at the preferred size, shrunk to fit.
 */
export function restoreBounds(
  saved: SavedWindow | undefined,
  workAreas: readonly Rectangle[],
): Rectangle & { maximized: boolean; fullScreen: boolean } {
  const primary = workAreas[0] ?? { x: 0, y: 0, ...preferred };
  if (saved) {
    const width = Math.max(minimumSize.width, saved.width);
    const height = Math.max(minimumSize.height, saved.height);
    const area = workAreas.find((candidate) => visible({ ...saved, width, height }, candidate));
    if (area) {
      return {
        x: saved.x,
        y: saved.y,
        width: Math.min(width, area.width),
        height: Math.min(height, area.height),
        maximized: saved.maximized,
        fullScreen: saved.fullScreen,
      };
    }
  }
  const width = Math.min(preferred.width, primary.width);
  const height = Math.min(preferred.height, primary.height);
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height,
    maximized: saved?.maximized ?? false,
    fullScreen: false,
  };
}

/** At least 120×80 px of the title area must land on the display to be reachable. */
function visible(window: Rectangle, area: Rectangle): boolean {
  const left = Math.max(window.x, area.x);
  const right = Math.min(window.x + window.width, area.x + area.width);
  const top = Math.max(window.y, area.y);
  const bottom = Math.min(window.y + 80, area.y + area.height);
  return right - left >= 120 && bottom - top >= 40;
}
