import type { BotPair } from "./model.ts";

/*
 * Colour pairs: a body colour and an accent. Dark values were chosen by eye; each light value is
 * its dark one with OKLab lightness lowered (chroma kept) until it holds 3:1 on white. Every value
 * holds at least 3:1 on its canvas (#0c0c0c dark, #ffffff light). The ink is Spade's alone.
 */

export type FaceScheme = "dark" | "light";

export const faceInk = "#141416";
export const facePaper = "#f6f6f7";
const blushPink = "#ff6d8d";

interface PairValues {
  body: string;
  accent: string;
}

export const botPairColours: Record<BotPair, Record<FaceScheme, PairValues>> = {
  ember: {
    dark: { body: "#F28C5E", accent: "#FFD08A" },
    light: { body: "#de7341", accent: "#bf8724" },
  },
  butter: {
    dark: { body: "#F5C451", accent: "#E06A3A" },
    light: { body: "#c18800", accent: "#E06A3A" },
  },
  mint: {
    dark: { body: "#6FD3A8", accent: "#2F8F74" },
    light: { body: "#1aa677", accent: "#2F8F74" },
  },
  lagoon: {
    dark: { body: "#4FC3C9", accent: "#F4A36B" },
    light: { body: "#00a2a9", accent: "#d57d3c" },
  },
  sky: {
    dark: { body: "#7FB0F5", accent: "#F7D774" },
    light: { body: "#5f93dd", accent: "#b38c00" },
  },
  lilac: {
    dark: { body: "#B79CF2", accent: "#7ED0B4" },
    light: { body: "#9f81dc", accent: "#3da385" },
  },
  rose: {
    dark: { body: "#F49AB9", accent: "#8E5BD6" },
    light: { body: "#d47497", accent: "#8E5BD6" },
  },
  berry: {
    dark: { body: "#E0607E", accent: "#FFC6A8" },
    light: { body: "#E0607E", accent: "#c48461" },
  },
  sage: {
    dark: { body: "#A7C77E", accent: "#E8925C" },
    light: { body: "#7a9c48", accent: "#d47a3e" },
  },
  cocoa: {
    dark: { body: "#C98B66", accent: "#F2D2A6" },
    light: { body: "#c3855f", accent: "#b08b55" },
  },
  stone: {
    dark: { body: "#B8BDC8", accent: "#6F86C9" },
    light: { body: "#8c929e", accent: "#6F86C9" },
  },
};

/** Every colour a face draws with, derived from its pair; none of them is stored. */
export interface FaceColours {
  /** The body. */
  body: string;
  /** The accent: inner ears, markings, accessories, species details. */
  accent: string;
  /** The body's shade (20% toward ink): its underside, and what ears sit on. */
  bodyShade: string;
  /** The accent's shade (26% toward ink). */
  accentShade: string;
  /** Pale body (58% toward paper): muzzle and belly. */
  pale: string;
  /** A bot's visor (78% toward ink). */
  visor: string;
  /** A mask marking (50% toward ink). */
  mask: string;
  blush: string;
  tongue: string;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

type Triple = [number, number, number];

function hexToRgb(hex: string): Triple {
  const read = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return [read(1), read(3), read(5)];
}

function rgbToHex(rgb: Triple): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function toOklab(hex: string): Triple {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Triple;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Triple): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgbToHex([
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** `from` with `amount` (0–1) of `toward` mixed in, in OKLab, as CSS `color-mix` does. */
export function mixFaceColour(from: string, toward: string, amount: number): string {
  const [aL, aA, aB] = toOklab(from);
  const [bL, bA, bB] = toOklab(toward);
  const mix = (x: number, y: number) => x * (1 - amount) + y * amount;
  return fromOklab([mix(aL, bL), mix(aA, bA), mix(aB, bB)]);
}

/** WCAG contrast between two hex colours. */
export function faceContrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map(toLinear) as Triple;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const derived = new Map<string, FaceColours>();

/** The colours a face in `pair` draws with on a `scheme` canvas. */
export function faceColours(pair: BotPair, scheme: FaceScheme): FaceColours {
  const key = `${pair}/${scheme}`;
  const known = derived.get(key);
  if (known) return known;
  const { body, accent } = botPairColours[pair][scheme];
  const colours: FaceColours = {
    body,
    accent,
    bodyShade: mixFaceColour(body, faceInk, 0.2),
    accentShade: mixFaceColour(accent, faceInk, 0.26),
    pale: mixFaceColour(body, facePaper, 0.58),
    visor: mixFaceColour(accent, faceInk, 0.78),
    mask: mixFaceColour(body, faceInk, 0.5),
    blush: mixFaceColour(blushPink, body, 0.38),
    tongue: mixFaceColour(blushPink, body, 0.3),
  };
  derived.set(key, colours);
  return colours;
}
