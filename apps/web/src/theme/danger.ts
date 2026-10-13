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
