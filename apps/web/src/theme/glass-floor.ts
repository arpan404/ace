import { backdropExtremes, type BackdropTone } from "./backdrops.ts";
import { contrastRatio, parseOpaqueColor, rgbToHex, type Rgb } from "./colour.ts";
import { over, selectedInk } from "./surfaces.ts";
import type { Base, Material, Scheme } from "./types.ts";

/*
 * How thin a theme's glass can be at its most translucent, and the legibility aids that let it
 * be thin. After Apple's materials, text on glass stays legible through the material, not only
 * through opacity:
 *
 *   - the backdrop is blurred, so text never sits on sharp detail (backdrops.ts);
 *   - its colour is boosted (`saturate`) so what's behind still reads as colour through the tint;
 *   - its range is compressed toward the glass (`contrast` below 1, then `brightness` up in light
 *     and down in dark): a luminosity scrim that keeps a white page from glaring through dark
 *     glass and a dark editor from muddying light glass;
 *   - text on glass is a step stronger than on solid surfaces (`glassText`).
 *
 * The tint is then the thinnest at which every text level reads at AA over the darkest and the
 * lightest backdrop the fixtures produce through that filter, a selected row's wash included.
 */

/** The luminosity scrim per scheme, at the most translucent end. */
const scrim: Record<Scheme, Pick<BackdropTone, "contrast" | "brightness">> = {
  light: { contrast: 0.72, brightness: 1.14 },
  dark: { contrast: 0.7, brightness: 0.72 },
};

/**
 * The backdrop filter's colour steps at `amount` of the way from Solid (0) to the most
 * translucent end (1): every step eases from no change to its full strength.
 */
export function glassTone(material: Material, scheme: Scheme, amount: number): BackdropTone {
  // A theme with no glass (Signal) has no backdrop to tone.
  const full = material.glass ? scrim[scheme] : { contrast: 1, brightness: 1 };
  const saturate = (material.glass?.saturate ?? 100) / 100;
  const toward = (end: number) => 1 + (end - 1) * amount;
  return {
    saturate: toward(saturate),
    contrast: toward(full.contrast),
    brightness: toward(full.brightness),
  };
}

const mixHex = (from: Rgb, to: Rgb, t: number): string =>
  rgbToHex([0, 1, 2].map((i) => Math.round(from[i]! * (1 - t) + to[i]! * t)) as unknown as Rgb);

/**
 * Text on glass: the text, secondary and quiet colours each moved part of the way toward the
 * scheme's extreme (black in light, white in dark). The hierarchy holds; each level just has a
 * little more weight over a moving backdrop.
 */
export function glassText(
  palette: Pick<Base, "t1" | "t2" | "t3">,
  scheme: Scheme,
): { t1: string; t2: string; t3: string } {
  const extreme: Rgb = scheme === "light" ? [0, 0, 0] : [255, 255, 255];
  const step = (value: string, t: number) => {
    const rgb = parseOpaqueColor(value);
    return rgb ? mixHex(rgb, extreme, t) : value;
  };
  return { t1: step(palette.t1, 0.4), t2: step(palette.t2, 0.35), t3: step(palette.t3, 0.3) };
}

/** Text and secondary text at AA (4.5:1); quiet hints that repeat a label at 3:1. */
export const glassTextLevels = [
  { key: "t1", minimum: 4.5 },
  { key: "t2", minimum: 4.5 },
  { key: "t3", minimum: 3 },
] as const;

/** Glass is never thinner than this, so it always reads as a surface. */
const minimumTint = 0.4;

/**
 * Whether every glass text level reads over glass of `palette.s2` at `alpha` over both
 * `backdrops` (`backdropExtremes`).
 */
export function glassReads(
  palette: Pick<Base, "s2" | "t1" | "t2" | "t3">,
  scheme: Scheme,
  alpha: number,
  backdrops: { dark: Rgb; light: Rgb },
): boolean {
  const glass = parseOpaqueColor(palette.s2);
  const text = glassText(palette, scheme);
  const ink = parseOpaqueColor(text.t1);
  if (!glass || !ink) return false;
  return [backdrops.dark, backdrops.light].every((backdrop) => {
    const behind = over(glass, alpha, backdrop);
    const selected = over(ink, selectedInk[scheme], behind);
    return glassTextLevels.every(({ key, minimum }) => {
      const colour = parseOpaqueColor(text[key]);
      return (
        !!colour &&
        contrastRatio(colour, behind) >= minimum &&
        contrastRatio(colour, selected) >= minimum
      );
    });
  });
}

/**
 * The glass tint's opacity at the most translucent end: the thinnest at which glass text reads
 * at AA over the realistic backdrops. Solved per theme and scheme when the theme is built, not
 * sampled per frame. 1 when the theme has no glass.
 */
export function glassTintAlpha(
  palette: Pick<Base, "s2" | "t1" | "t2" | "t3" | "material">,
  scheme: Scheme,
): number {
  const glass = palette.material.glass;
  if (!glass) return 1;
  const backdrops = backdropExtremes(glass.blur, glassTone(palette.material, scheme, 1));
  for (let percent = Math.round(minimumTint * 100); percent < 100; percent++)
    if (glassReads(palette, scheme, percent / 100, backdrops)) return percent / 100;
  return 1;
}
