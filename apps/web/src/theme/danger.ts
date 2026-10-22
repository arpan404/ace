import { contrastRatio, oklchToHex, parseOpaqueColor, rgbToOklch, type Rgb } from "./colour.ts";

/*
 * The danger fill: the solid red of destructive actions (Delete, Remove, Revoke). It is the
 * theme's failed hue drawn as one clear red, the same depth in every theme and scheme: not the
 * deep failed mark of light themes (it reads muddy as a fill) and not the light one of dark
 * themes (it reads pink). It steps deeper only if a white label would fall under AA. Hover and
 * pressed step darker, which only raises the label's contrast.
 */

const white: Rgb = [255, 255, 255];
/** A little over 4.5:1, so rounding to hex never lands under AA. */
const minimum = 4.6;
/** The red's depth and colourfulness (OKLCH): bright enough to read as red, not coral. */
const lightness = 0.555;
const chroma = 0.2;
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
  const { c, h } = rgbToOklch(parseOpaqueColor(failed) ?? [180, 40, 40]);
  const vivid = Math.max(c, chroma);
  let l = lightness;
  while (l > 0 && !readsWhite(oklchToHex(l, vivid, h))) l -= 0.005;
  const at = (step: number) => oklchToHex(Math.max(0, l - step), vivid, h);
  return {
    fill: at(0),
    hover: at(hoverStep),
    pressed: at(pressedStep),
    foreground: "#FFFFFF",
  };
}
