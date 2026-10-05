/*
 * Colour maths for the theme engine: parsing, WCAG contrast, blending, OKLCH to sRGB for the
 * generated palettes, and text colours that read on a fill or across surfaces.
 */

export type Rgb = readonly [number, number, number];

const hexChannel = (digits: string, at: number) => Number.parseInt(digits.slice(at, at + 2), 16);

/** Opaque hex or rgb() colours only; translucent values have no fixed contrast. */
export function parseOpaqueColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [hexChannel(digits, 0), hexChannel(digits, 2), hexChannel(digits, 4)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/i.exec(text);
  if (!rgb) return undefined;
  if (rgb[4] !== undefined && Number(rgb[4]) < 1) return undefined;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const toByte = (channel: number): number => {
  const c = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
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

const black: Rgb = [0, 0, 0];
const white: Rgb = [255, 255, 255];

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * Text for a label on a fill of `colour`: black or white, whichever reads better. One of the two
 * always reaches 4.58:1, so the label is AA whatever the fill. A colour that cannot be parsed (a
 * `var()` in a custom theme) gets white.
 */
export function readableOn(colour: string): string {
  const fill = parseOpaqueColor(colour);
  if (!fill) return "#FFFFFF";
  return contrastRatio(black, fill) > contrastRatio(white, fill) ? "#000000" : "#FFFFFF";
}

/** The lowest contrast `colour` has against any of `surfaces`. */
export function worstContrast(colour: Rgb, surfaces: readonly Rgb[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(colour, surface)));
}

/**
 * `colour` as text that reads at AA on every one of `surfaces`: the colour itself when it does,
 * else the nearest step of it toward black (light surfaces) or white (dark ones) that does.
 * Undefined when even black or white cannot, or the colour cannot be parsed.
 */
export function readableAcross(
  colour: string,
  surfaces: readonly Rgb[],
  dark: boolean,
  minimum = 4.5,
): string | undefined {
  const start = parseOpaqueColor(colour);
  if (!start || surfaces.length === 0) return undefined;
  const target = dark ? white : black;
  for (let step = 0; step <= 40; step++) {
    const t = step / 40;
    const candidate: Rgb = [0, 1, 2].map((i) => start[i]! + (target[i]! - start[i]!) * t) as [
      number,
      number,
      number,
    ];
    const rounded: Rgb = candidate.map(Math.round) as [number, number, number];
    if (worstContrast(rounded, surfaces) >= minimum) return rgbToHex(rounded);
  }
  return undefined;
}
