import {
  deriveAccent,
  oklchToHex,
  parseOpaqueColor,
  rgbToOklab,
  type Accent,
  type Palette,
  type Rgb,
  type Scheme,
} from "@ace/themes";
import { revealCeiling } from "./reveal.ts";

/*
 * ace's colours from a Suit's video (ADR 0169). Pure: a small grid of the frame in, the
 * picture's strongest colour out, then that colour fitted as an accent (`deriveAccent`: labels
 * read, it stands off the page, it never passes for a status) and as a tint of the veil that
 * never lets the frame's text read worse than the untinted veil would.
 */

type Lab = readonly [number, number, number];

/** Below this OKLab chroma a picture has no colour worth following. */
const greyChroma = 0.04;
const hueBins = 12;

const labToHex = ([l, a, b]: Lab) => {
  const chroma = Math.hypot(a, b);
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return oklchToHex(Math.min(1, Math.max(0, l)), chroma, hue);
};

/**
 * The picture's strongest colour as `#RRGGBB`: the hue most of its coloured area shares,
 * weighted by chroma and by how far each pixel is from black or white, averaged in OKLab.
 * Undefined for a grey, black or white picture, which leaves the Suit's own colours alone.
 * `pixels` is RGBA, row by row.
 */
export function strongestColour(pixels: ArrayLike<number>): string | undefined {
  const bins = Array.from({ length: hueBins }, () => ({ weight: 0, l: 0, a: 0, b: 0 }));
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const alpha = (pixels[at + 3] ?? 0) / 255;
    if (alpha < 0.5) continue;
    const [l, a, b] = rgbToOklab([pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0]);
    const chroma = Math.hypot(a, b);
    if (chroma < greyChroma) continue;
    // Mid-tones carry a picture's colour; near-black and near-white pixels barely do.
    const middle = Math.max(0, 1 - Math.abs(l - 0.6) / 0.45);
    const weight = chroma * middle * alpha;
    if (weight <= 0) continue;
    const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    const bin = bins[Math.floor(hue / (360 / hueBins)) % hueBins];
    if (!bin) continue;
    bin.weight += weight;
    bin.l += l * weight;
    bin.a += a * weight;
    bin.b += b * weight;
  }
  const best = bins.reduce((top, bin) => (bin.weight > top.weight ? bin : top));
  if (best.weight <= 0) return undefined;
  return labToHex([best.l / best.weight, best.a / best.weight, best.b / best.weight]);
}

/**
 * `from` moved toward `to` by `amount` (0–1) in OKLab, so a cut in the video eases over a few
 * samples instead of flashing. Undefined `from` takes `to` at once.
 */
export function easeColour(from: string | undefined, to: string, amount: number): string {
  const end = parseOpaqueColor(to);
  const start = from === undefined ? undefined : parseOpaqueColor(from);
  if (!end) return from ?? to;
  if (!start) return to;
  const t = Math.min(1, Math.max(0, amount));
  const x = rgbToOklab(start);
  const y = rgbToOklab(end);
  return labToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** The accent tokens for a picked colour on the Suit's palette, fitted as a person's pick is. */
export function videoAccent(colour: string, scheme: Scheme, palette: Palette): Accent {
  return deriveAccent(colour, scheme, palette);
}

const mix = (a: Rgb, b: Rgb, t: number): string => {
  const x = rgbToOklab(a);
  const y = rgbToOklab(b);
  return labToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};

/**
 * The veil's colour: `surface` taking up to `tint` of `colour`, less wherever the tint would let
 * `text` read worse over any frame than the untinted veil does at `reveal` (`revealCeiling`).
 */
export function tintedVeil(input: {
  surface: string;
  text: string;
  colour: string;
  tint: number;
  reveal: number;
}): string {
  const surface = parseOpaqueColor(input.surface);
  const colour = parseOpaqueColor(input.colour);
  if (!surface || !colour) return input.surface;
  const holds = Math.min(input.reveal, revealCeiling({ text: input.text, surface: input.surface }));
  for (let tint = Math.min(0.25, Math.max(0, input.tint)); tint > 0.001; tint -= 0.02) {
    const veil = mix(surface, colour, tint);
    if (revealCeiling({ text: input.text, surface: veil }) >= holds) return veil;
  }
  return input.surface;
}
