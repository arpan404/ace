import { glassTone } from "./glass-floor.ts";
import type { Palette, Scheme } from "./types.ts";

/*
 * Translucency: how much of what's behind a floating layer shows through, from Solid (0) to the
 * theme's most translucent glass (`translucencyMax`). The most translucent end is the thinnest
 * tint at which glass text still reads at AA over realistic blurred backdrops (`glassTintAlpha`,
 * glass-floor.ts), so no setting of the slider can make text unreadable. Toward Solid the tint
 * thickens, and the blur, colour boost and luminosity scrim fade; at 0 the layer is solid and
 * has no backdrop filter at all.
 */

/** The most translucent setting: the theme's AA-safe glass. */
export const translucencyMax = 100;
/** The slider moves in tenths. */
export const translucencyStep = 10;
/** The theme's own glass: the most translucent end. */
export const defaultTranslucency = translucencyMax;

/** `value` as a stored setting: whole steps from 0 to `translucencyMax`. */
export function snapTranslucency(value: number): number {
  if (!Number.isFinite(value)) return defaultTranslucency;
  const snapped = Math.round(value / translucencyStep) * translucencyStep;
  return Math.min(translucencyMax, Math.max(0, snapped));
}

/**
 * How far along the slider's glass is, 0 at Solid to 1 at the most translucent end. Eased (a
 * square root), so the middle of the slider looks halfway: a tint only a few percent thinner
 * than solid still reads as solid, and the first steps away from Solid need to show more.
 */
export function glassAmount(translucency: number): number {
  return Math.sqrt(snapTranslucency(translucency) / translucencyMax);
}

/** The glass variables a floating layer reads (styles/glass.css). */
export interface GlassVariables {
  "--glass-tint": string;
  "--glass-blur": string;
  "--glass-saturate": string;
  "--glass-contrast": string;
  "--glass-brightness": string;
}

/**
 * The glass of `palette` at `translucency`: the tint's opacity runs from 1 at Solid to the
 * theme's AA floor at the most translucent end, and the blur, colour boost and luminosity scrim
 * scale with it. Only these variables change as the slider moves, so a drag never rebuilds a
 * stylesheet or a displacement map.
 */
export function glassVariables(
  palette: Pick<Palette, "s2" | "glassTint" | "material">,
  scheme: Scheme,
  translucency: number,
): GlassVariables {
  const amount = glassAmount(translucency);
  const alpha = 1 - amount * (1 - palette.glassTint);
  const tone = glassTone(palette.material, scheme, amount);
  return {
    "--glass-tint": `color-mix(in srgb, ${palette.s2} ${Math.round(alpha * 100)}%, transparent)`,
    "--glass-blur": `${round((palette.material.glass?.blur ?? 0) * amount)}px`,
    "--glass-saturate": `${round(tone.saturate * 100)}%`,
    "--glass-contrast": `${round(tone.contrast * 100)}%`,
    "--glass-brightness": `${round(tone.brightness * 100)}%`,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
