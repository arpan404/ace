import type { Palette } from "./types.ts";

/*
 * Translucency: how much of what's behind a floating layer shows through, from Solid (0) to the
 * theme's most translucent glass (`translucencyMax`). The most translucent end is the thinnest
 * tint at which text still reads at AA over a white and a black backdrop (`glassTintAlpha`), so
 * no setting of the slider can make text unreadable. The tint thickens toward solid and the blur
 * and colour boost fade with it; at 0 the layer is solid and has no backdrop filter at all.
 */

/** The most translucent setting: the theme's AA-safe glass. */
export const translucencyMax = 100;
/** The slider moves in tenths. */
export const translucencyStep = 10;
/** The look Translucent had before the slider: the theme's computed glass. */
export const defaultTranslucency = translucencyMax;

/** `value` as a stored setting: whole steps from 0 to `translucencyMax`. */
export function snapTranslucency(value: number): number {
  if (!Number.isFinite(value)) return defaultTranslucency;
  const snapped = Math.round(value / translucencyStep) * translucencyStep;
  return Math.min(translucencyMax, Math.max(0, snapped));
}

/** The glass variables a floating layer reads (styles/glass.css). */
export interface GlassVariables {
  "--glass-tint": string;
  "--glass-blur": string;
  "--glass-saturate": string;
}

/**
 * The glass of `palette` at `translucency`: the tint's opacity runs from 1 at Solid to the
 * theme's AA floor at the most translucent end, and the blur and saturation scale with it.
 * Only these three variables change as the slider moves, so a drag never rebuilds a stylesheet
 * or a displacement map.
 */
export function glassVariables(
  palette: Pick<Palette, "s2" | "glassTint" | "material">,
  translucency: number,
): GlassVariables {
  const amount = snapTranslucency(translucency) / translucencyMax;
  const glass = palette.material.glass;
  const alpha = 1 - amount * (1 - palette.glassTint);
  return {
    "--glass-tint": `color-mix(in srgb, ${palette.s2} ${Math.round(alpha * 100)}%, transparent)`,
    "--glass-blur": `${round((glass?.blur ?? 0) * amount)}px`,
    "--glass-saturate": `${round(100 + ((glass?.saturate ?? 100) - 100) * amount)}%`,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
