import { contrastRatio, parseOpaqueColor } from "./contrast.ts";

/*
 * Colour maths the theme engine needs at build time of a theme: OKLCH to sRGB for the generated
 * palettes, and the text colour that reads on an accent fill.
 */

const toByte = (linear: number): number => {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

/** Linear sRGB of an OKLCH colour, possibly outside [0, 1] when out of gamut. */
function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
}

/** OKLCH (lightness 0..1, chroma, hue in degrees) as "#RRGGBB", chroma reduced into sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  let chroma = c;
  let rgb = oklchToLinear(l, chroma, h);
  while (chroma > 0 && rgb.some((v) => v < -0.0001 || v > 1.0001)) {
    chroma -= 0.005;
    rgb = oklchToLinear(l, Math.max(0, chroma), h);
  }
  return `#${rgb.map((v) => toByte(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const black = "#111111";
const white = "#FFFFFF";

/**
 * Text for a label on a fill of `colour`: near-black or white, whichever reads better. A colour
 * that cannot be parsed (a `var()` in a custom theme) gets white.
 */
export function readableOn(colour: string): string {
  const fill = parseOpaqueColor(colour);
  if (!fill) return white;
  const dark = parseOpaqueColor(black);
  const light = parseOpaqueColor(white);
  if (!dark || !light) return white;
  return contrastRatio(dark, fill) > contrastRatio(light, fill) ? black : white;
}
