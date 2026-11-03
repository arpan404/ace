import { oklchToHex, parseOpaqueColor, rgbToOklch, type Rgb } from "./colour.ts";

/*
 * A raised surface (popovers, menus, the command palette) is the canvas lifted, never a different
 * colour: it keeps its designed lightness but takes the canvas's hue and chroma, so a tinted
 * theme's palette reads as the same cream, blue or green raised off the page, not a neutral sheet
 * over it. Where sRGB can't hold that chroma at the raised lightness (a light theme near white),
 * the surface steps toward the canvas's lightness until it can, and is the canvas at the limit.
 * Pure.
 */

/** `surface` with `canvas`'s hue and chroma, as near its own lightness as sRGB allows. */
export function tintedLike(surface: string, canvas: string): string {
  const own = rgbToOklch(opaque(surface));
  const base = rgbToOklch(opaque(canvas));
  // Nothing to carry: a neutral canvas leaves the surface as designed.
  if (base.c < 0.001) return surface;
  const steps = 100;
  for (let step = 0; step <= steps; step++) {
    const l = own.l + ((base.l - own.l) * step) / steps;
    const candidate = oklchToHex(l, base.c, base.h);
    // `oklchToHex` gives up chroma to stay in sRGB: accept only a colour that kept it.
    if (rgbToOklch(opaque(candidate)).c >= base.c - 0.0015) return candidate;
  }
  return canvas;
}

function opaque(colour: string): Rgb {
  const rgb = parseOpaqueColor(colour);
  if (!rgb) throw new Error(`Surfaces need opaque colours: ${colour}`);
  return rgb;
}
