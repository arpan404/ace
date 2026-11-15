import { oklchToHex } from "./colour.ts";
import type { Scheme } from "./types.ts";

/**
 * Project badge tints: twelve hues around the wheel at one perceptual lightness per scheme, so
 * no project looks louder than another. Each reads as text on the theme's surfaces (AA).
 */
const projectHues = [25, 55, 85, 125, 150, 178, 205, 240, 268, 295, 325, 355] as const;
const projectLightness: Record<Scheme, { l: number; c: number }> = {
  dark: { l: 0.85, c: 0.12 },
  light: { l: 0.41, c: 0.14 },
};

/** How many project tints a theme has; `--project-1` to `--project-${projectTintCount}`. */
export const projectTintCount = projectHues.length;

/** The project tints of a scheme, in badge order. */
export function projectTints(scheme: Scheme): readonly string[] {
  const { l, c } = projectLightness[scheme];
  return projectHues.map((hue) => oklchToHex(l, c, hue));
}
