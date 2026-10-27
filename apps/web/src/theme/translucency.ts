import { glassTone, type Palette, type Scheme } from "@ace/themes";

/*
 * Translucency: how much of what's behind a floating layer shows through, from Solid (0) to the
 * theme's most translucent glass (`translucencyMax`), and past it to extra-clear
 * (`translucencyClearMax`). The AA-safe end is the thinnest tint at which glass text still reads
 * at AA over realistic blurred backdrops (`glassTintAlpha`, glass-floor.ts). Past it the tint
 * keeps thinning toward a floor, with a note in Settings that text may read softer — the blur,
 * colour boost and luminosity scrim are already at full strength there, so only the tint moves.
 * Toward Solid the tint thickens, and the blur, colour boost and luminosity scrim fade; at 0 the
 * layer is solid and has no backdrop filter at all.
 */

/** The most translucent AA-safe setting: the theme's glass, and the default. */
export const translucencyMax = 100;
/** The slider moves in tenths. */
export const translucencyStep = 10;
/** The absolute max: extra-clear glass past the AA-safe end; softer text, not guaranteed AA. */
export const translucencyClearMax = 150;
/** The theme's own glass: the AA-safe end. */
export const defaultTranslucency = translucencyMax;
/** Even extra-clear glass never thins past this, so layers still read as a surface. */
export const extraClearTintFloor = 0.15;
/**
 * A modal panel (the command palette) is never thinner than this. It adds no blur of its own
 * over the page its backdrop has blurred lightly (`--backdrop-blur`), so the thin floating tint,
 * solved for a layer's own heavier blur, would show the page through it. Near-solid instead:
 * text and fields read as on a solid surface, at any Translucency.
 */
export const modalTintFloor = 0.92;

/** `value` as a stored setting: whole steps from 0 to `translucencyClearMax`. */
export function snapTranslucency(value: number): number {
  if (!Number.isFinite(value)) return defaultTranslucency;
  const snapped = Math.round(value / translucencyStep) * translucencyStep;
  return Math.min(translucencyClearMax, Math.max(0, snapped));
}

/**
 * How far along the slider's glass is, 0 at Solid to 1 at the AA-safe end. Eased (a square
 * root), so the middle of the slider looks halfway: a tint only a few percent thinner than
 * solid still reads as solid, and the first steps away from Solid need to show more. Past the
 * AA-safe end it keeps thinning linearly toward clear, so the extra range feels like more of
 * the same drag.
 */
export function glassAmount(translucency: number): number {
  const snapped = snapTranslucency(translucency);
  if (snapped <= translucencyMax) return Math.sqrt(snapped / translucencyMax);
  return 1 + ((snapped - translucencyMax) / (translucencyClearMax - translucencyMax)) * 0.5;
}

/** The glass variables a floating layer reads (styles/glass.css). */
export interface GlassVariables {
  "--glass-tint": string;
  /** The modal panel's tint: the glass tint, never thinner than `modalTintFloor`. */
  "--glass-tint-modal": string;
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
  // The filter is already at full strength at the AA-safe end; past it only the tint thins.
  const full = Math.min(amount, 1);
  const alpha = Math.max(extraClearTintFloor, 1 - amount * (1 - palette.glassTint));
  const tone = glassTone(palette.material, scheme, full);
  return {
    "--glass-tint": tint(palette.s2, alpha),
    "--glass-tint-modal": tint(palette.s2, Math.max(modalTintFloor, alpha)),
    "--glass-blur": `${round((palette.material.glass?.blur ?? 0) * full)}px`,
    "--glass-saturate": `${round(tone.saturate * 100)}%`,
    "--glass-contrast": `${round(tone.contrast * 100)}%`,
    "--glass-brightness": `${round(tone.brightness * 100)}%`,
  };
}

const tint = (surface: string, alpha: number) =>
  `color-mix(in srgb, ${surface} ${Math.round(alpha * 100)}%, transparent)`;

const round = (value: number) => Math.round(value * 10) / 10;
