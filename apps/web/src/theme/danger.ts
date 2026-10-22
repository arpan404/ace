import { contrastRatio, oklchToHex, parseOpaqueColor, rgbToOklch, type Rgb } from "./colour.ts";

/*
 * The danger fill: the solid button that confirms a destructive action (Delete, Remove, Revoke).
 * It is the theme's failed hue, at the lightest step where a white label still reads at AA, so
 * light themes keep their red as drawn and dark themes (whose failed mark is a light red) get a
 * deeper one. Hover and pressed step darker, which only raises the label's contrast.
 */

const white: Rgb = [255, 255, 255];
/** A little over 4.5:1, so rounding to hex never lands under AA. */
const minimum = 4.6;
const hoverStep = 0.04;
const pressedStep = 0.08;

export interface DangerFill {
  fill: string;
  hover: string;
  pressed: string;
  foreground: string;
}

const readsWhite = (hex: string) => {
  const rgb = parseOpaqueColor(hex);
  return rgb !== undefined && contrastRatio(white, rgb) >= minimum;
};

/** The danger fill and its states for a theme whose failed mark is `failed`. */
export function dangerFill(failed: string): DangerFill {
  const { l, c, h } = rgbToOklch(parseOpaqueColor(failed) ?? [180, 40, 40]);
  let lightness = l;
  while (lightness > 0 && !readsWhite(oklchToHex(lightness, c, h))) lightness -= 0.005;
  const at = (step: number) => oklchToHex(Math.max(0, lightness - step), c, h);
  return {
    fill: at(0),
    hover: at(hoverStep),
    pressed: at(pressedStep),
    foreground: "#FFFFFF",
  };
}

/** An icon reads at 3:1 (WCAG 1.4.11); a little over so rounding never lands under. */
const iconMinimum = 3.2;
/** A clear, bright red: no lighter (it turns coral) and no greyer than this. */
const stopLightness = 0.62;
const stopChroma = 0.19;

const iconReads = (hex: string) => {
  const rgb = parseOpaqueColor(hex);
  return rgb !== undefined && contrastRatio(white, rgb) >= iconMinimum;
};

/**
 * The Stop button's fill: the theme's failed hue as a bright red. It carries only an icon, so it
 * may stay lighter than the danger fill, as long as the white glyph reads at 3:1.
 */
export function stopFill(failed: string): DangerFill {
  const { c, h } = rgbToOklch(parseOpaqueColor(failed) ?? [180, 40, 40]);
  const chroma = Math.max(c, stopChroma);
  let lightness = stopLightness;
  while (lightness > 0 && !iconReads(oklchToHex(lightness, chroma, h))) lightness -= 0.005;
  const at = (step: number) => oklchToHex(Math.max(0, lightness - step), chroma, h);
  return { fill: at(0), hover: at(hoverStep), pressed: at(pressedStep), foreground: "#FFFFFF" };
}
