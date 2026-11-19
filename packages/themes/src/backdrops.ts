import type { Rgb } from "./colour.ts";

/*
 * What glass actually sits over, once the browser has frosted it. A floating layer never shows
 * its backdrop sharp: `backdrop-filter` blurs it (a Gaussian whose standard deviation is the blur
 * radius), then boosts its colour and compresses its range. So the worst case for text on glass
 * is not a pure white or black pixel but the lightest and darkest colour busy content still has
 * after that filter.
 *
 * Four fixtures stand in for that content, each a 256px tile repeated across the screen: a dark
 * code editor, a white web page with a wide margin, a photo with sunlit and shadowed areas, and
 * dense black-on-white prose. They are drawn at 8px cells, each cell the average colour of the
 * glyphs or pixels in it (text rows are about a third ink), which is what any blur of 8px or more
 * sees anyway. The filter chain runs as the browser runs it, in sRGB: blur, saturate, contrast,
 * brightness. The lightest and darkest results are the backdrops glass must keep text readable
 * over (`glassTintAlpha` in surfaces.ts).
 */

/** One cell in CSS px. */
const cell = 8;
/** Cells per side of a fixture tile (256px). */
const size = 32;

type Pixels = Float64Array; // r, g, b in 0..1 per cell, row-major

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];
const mix = (a: readonly number[], b: readonly number[], t: number) =>
  [0, 1, 2].map((i) => a[i]! * (1 - t) + b[i]! * t);

function tile(paint: (x: number, y: number) => readonly number[]): Pixels {
  const pixels = new Float64Array(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) pixels.set(paint(x, y), (y * size + x) * 3);
  return pixels;
}

/** A deterministic line length for row `line` (0..1 of the width), like ragged text or code. */
const ragged = (line: number, seed: number) => 0.35 + 0.65 * ((((line + 1) * seed) % 17) / 16);

/** Smoothstep, for soft edges between areas of a photo. */
const soft = (t: number) => t * t * (3 - 2 * t);

/** Text rows: one ink row in every three (24px lines), at about a third ink coverage. */
const ink = 0.33;

const fixtures: Record<string, Pixels> = {
  /** A dark editor: light and coloured syntax on #1e1e1e, ragged lines, some blank. */
  code: (() => {
    const background = rgb("#1e1e1e");
    const syntax = [rgb("#d4d4d4"), rgb("#569cd6"), rgb("#ce9178"), rgb("#4ec9b0")];
    return tile((x, y) => {
      const line = Math.floor(y / 3);
      const indent = (line % 4) * 2;
      const end = indent + Math.round(ragged(line, 7) * (size - indent));
      const text = y % 3 === 0 && line % 6 !== 5 && x >= indent && x < end;
      return text ? mix(background, syntax[(x + line) % syntax.length]!, ink) : background;
    });
  })(),
  /** A white web page: paragraphs of dark text, a 96px blank margin and a gap between blocks. */
  whitePage: (() => {
    const paper = rgb("#ffffff");
    const text = rgb("#111111");
    return tile((x, y) => {
      const line = Math.floor(y / 3);
      const inBlock = y < 20;
      const end = Math.round(ragged(line, 5) * 20);
      return inBlock && y % 3 === 0 && x < end ? mix(paper, text, ink) : paper;
    });
  })(),
  /** A photo: sky, sunlit sand, foliage and a deep shadow, with soft edges between them. */
  photo: (() => {
    const quadrants = [rgb("#7fb2e8"), rgb("#f4d58a"), rgb("#1f3a1a"), rgb("#0f0f14")];
    return tile((x, y) => {
      const u = soft(Math.min(1, Math.max(0, (x - 12) / 8)));
      const v = soft(Math.min(1, Math.max(0, (y - 12) / 8)));
      const top = mix(quadrants[0]!, quadrants[1]!, u);
      const bottom = mix(quadrants[2]!, quadrants[3]!, u);
      return mix(top, bottom, v);
    });
  })(),
  /** Dense prose, black on white, every line full. */
  prose: (() => {
    const paper = rgb("#ffffff");
    const text = rgb("#000000");
    return tile((_x, y) => (y % 3 === 0 ? mix(paper, text, ink) : paper));
  })(),
};

/** A periodic Gaussian blur of a tile, separable, with standard deviation `sigma` in cells. */
function blur(pixels: Pixels, sigma: number): Pixels {
  if (sigma <= 0) return pixels;
  const reach = Math.ceil(sigma * 3);
  const weights = Array.from({ length: reach * 2 + 1 }, (_, i) =>
    Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const pass = (source: Pixels, horizontal: boolean) => {
    const out = new Float64Array(source.length);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = -reach; k <= reach; k++) {
            const sx = horizontal ? (((x + k) % size) + size) % size : x;
            const sy = horizontal ? y : (((y + k) % size) + size) % size;
            sum += source[(sy * size + sx) * 3 + c]! * weights[k + reach]!;
          }
          out[(y * size + x) * 3 + c] = sum / total;
        }
    return out;
  };
  return pass(pass(pixels, true), false);
}

/** The backdrop filter's colour steps after the blur, as CSS defines them (filter-effects). */
export interface BackdropTone {
  /** `saturate()`, 1 = unchanged. */
  saturate: number;
  /** `contrast()`, 1 = unchanged; below 1 pulls every colour toward mid-grey. */
  contrast: number;
  /** `brightness()`, 1 = unchanged. */
  brightness: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function tone([r, g, b]: readonly number[], { saturate: s, contrast, brightness }: BackdropTone) {
  // The saturate() matrix from Filter Effects 1.
  const saturated = [
    (0.213 + 0.787 * s) * r! + (0.715 - 0.715 * s) * g! + (0.072 - 0.072 * s) * b!,
    (0.213 - 0.213 * s) * r! + (0.715 + 0.285 * s) * g! + (0.072 - 0.072 * s) * b!,
    (0.213 - 0.213 * s) * r! + (0.715 - 0.715 * s) * g! + (0.072 + 0.928 * s) * b!,
  ].map(clamp);
  return saturated.map((c) => clamp(clamp((c - 0.5) * contrast + 0.5) * brightness));
}

const blurred = new Map<number, Pixels[]>();

/** Every fixture blurred at `radius` CSS px, computed once per radius. */
function blurredFixtures(radius: number): Pixels[] {
  const key = Math.round(radius * 10) / 10;
  let found = blurred.get(key);
  if (!found) {
    found = Object.values(fixtures).map((pixels) => blur(pixels, key / cell));
    blurred.set(key, found);
  }
  return found;
}

const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** WCAG relative luminance of a 0..1 sRGB colour. */
const relative = ([r, g, b]: readonly number[]) =>
  0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);

/** A 0..1 sRGB colour as 0..255 channels. */
const bytes = (colour: readonly number[]): Rgb => {
  const [r, g, b] = colour.map((c) => Math.round(c * 255));
  return [r!, g!, b!];
};

/**
 * The darkest and the lightest colour any fixture shows through a backdrop filter of `radius`
 * px and `toning`, as 0..255 sRGB: the two backdrops text on glass must hold over.
 */
export function backdropExtremes(radius: number, toning: BackdropTone): { dark: Rgb; light: Rgb } {
  let dark: number[] = [1, 1, 1];
  let light: number[] = [0, 0, 0];
  for (const pixels of blurredFixtures(radius))
    for (let i = 0; i < pixels.length; i += 3) {
      const colour = tone([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!], toning);
      if (relative(colour) < relative(dark)) dark = colour;
      if (relative(colour) > relative(light)) light = colour;
    }
  return { dark: bytes(dark), light: bytes(light) };
}
