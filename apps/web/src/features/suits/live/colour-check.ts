import type { SuitProblem } from "@ace/protocol/suits";
import { contrastRatio, type Rgb } from "@/theme/contrast.ts";

/*
 * The live contrast check's maths (ADR 0150, "Shown perfectly"). The DOM shell (`collect.ts`)
 * reads each text-bearing part's computed colours and the layers behind it; this decides what
 * colour the text and its background end up as on screen and whether they meet WCAG. Pure.
 */

/** sRGB channels 0–255 and alpha 0–1. */
export type Rgba = readonly [number, number, number, number];

/** One element between the text and what lies beneath the app: its paint and its opacity. */
export interface PaintLayer {
  /** `background-color`. */
  color: Rgba;
  /** Colours of the gradient stops in `background-image`, painted over `color`; may be empty. */
  stops: readonly Rgba[];
  /** The element's `opacity`, which applies to it and everything inside it. */
  opacity: number;
}

export interface ColourSample {
  part: string;
  /** Words need 4.5:1 (3:1 when large); marks (icons) need 3:1. */
  kind: "text" | "mark";
  /** The text's or mark's own colour. */
  fg: Rgba;
  /** From the outermost layer that matters to the element itself. */
  layers: readonly PaintLayer[];
  /** What shows beneath the outermost layer: scene samples, or the page's base colour. */
  backdrop: readonly Rgb[];
  /** px */
  fontSize: number;
  fontWeight: number;
}

const channel = (value: string): number | undefined => {
  const text = value.trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
};
const alphaOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return 1;
  const text = value.trim();
  const number = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined;
};

/**
 * A colour as `getComputedStyle` reports it: `rgb()`/`rgba()` in either syntax, `transparent`,
 * or `color(srgb r g b / a)`. Undefined for anything else (the shell resolves those itself).
 */
export function parseComputedColour(value: string): Rgba | undefined {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  const rgb = /^rgba?\((.*)\)$/.exec(text);
  if (rgb?.[1] !== undefined) {
    const [body, slash] = rgb[1].split("/");
    const parts = (body ?? "").split(/[\s,]+/).filter(Boolean);
    const alpha = slash !== undefined ? slash : parts.length === 4 ? parts.pop() : undefined;
    if (parts.length !== 3) return undefined;
    const [r, g, b] = parts.map(channel);
    const a = alphaOf(alpha);
    if (r === undefined || g === undefined || b === undefined || a === undefined) return undefined;
    return [r, g, b, a];
  }
  const srgb = /^color\(srgb\s+([^/)]+)(?:\/\s*([^)]+))?\)$/.exec(text);
  if (srgb?.[1] !== undefined) {
    const parts = srgb[1].trim().split(/\s+/).map(Number);
    const a = alphaOf(srgb[2]);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)) || a === undefined)
      return undefined;
    const [r = 0, g = 0, b = 0] = parts.map((part) => Math.min(1, Math.max(0, part)) * 255);
    return [r, g, b, a];
  }
  return undefined;
}

/** Every colour named in a computed `background-image` (gradient stops); [] for `none`. */
export function gradientStops(backgroundImage: string): string[] {
  return backgroundImage.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)|transparent/gi) ?? [];
}

/** `top` painted over an opaque `below`, with `alpha` scaling its own alpha. */
export function over(top: Rgba, below: Rgb, alpha = 1): Rgb {
  const a = top[3] * alpha;
  return [
    top[0] * a + below[0] * (1 - a),
    top[1] * a + below[1] * (1 - a),
    top[2] * a + below[2] * (1 - a),
  ];
}

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
];

/**
 * The pixel that shows through `layers` (outermost first) over `below`, with `top` painted
 * inside the innermost one when given. An element's opacity mixes everything it paints with
 * what lies under it, which is a straight mix between the two results.
 */
function paint(
  layers: readonly PaintLayer[],
  stops: readonly (Rgba | undefined)[],
  at: number,
  below: Rgb,
  top: Rgba | undefined,
): Rgb {
  const layer = layers[at];
  if (!layer) return top ? over(top, below) : below;
  let inside = over(layer.color, below);
  const stop = stops[at];
  if (stop) inside = over(stop, inside);
  inside = paint(layers, stops, at + 1, inside, top);
  return mix(below, inside, Math.min(1, Math.max(0, layer.opacity)));
}

/** At most this many backgrounds are tried per sample (gradient stops times backdrops). */
const maxTries = 96;

/** Each way the backgrounds can combine: one stop per layer that has any. */
function stopChoices(layers: readonly PaintLayer[]): (Rgba | undefined)[][] {
  let choices: (Rgba | undefined)[][] = [[]];
  for (const layer of layers) {
    const options = layer.stops.length > 0 ? layer.stops : [undefined];
    const next: (Rgba | undefined)[][] = [];
    for (const choice of choices)
      for (const option of options) {
        if (next.length >= maxTries) break;
        next.push([...choice, option]);
      }
    choices = next;
  }
  return choices;
}

export interface Measured {
  ratio: number;
  fg: Rgb;
  bg: Rgb;
}

/** The lowest contrast the sample's text or mark has over any of its possible backgrounds. */
export function worstContrast(sample: ColourSample): Measured | undefined {
  let worst: Measured | undefined;
  let tries = 0;
  const backdrops = sample.backdrop.length > 0 ? sample.backdrop : [[255, 255, 255] as const];
  for (const stops of stopChoices(sample.layers))
    for (const below of backdrops) {
      if (++tries > maxTries) return worst;
      const bg = paint(sample.layers, stops, 0, below, undefined);
      const fg = paint(sample.layers, stops, 0, below, sample.fg);
      const ratio = contrastRatio(fg, bg);
      if (!worst || ratio < worst.ratio) worst = { ratio, fg, bg };
    }
  return worst;
}

/** WCAG 2: large text is 24 px, or 18.66 px (14 pt) when bold. */
export const isLargeText = (fontSize: number, fontWeight: number) =>
  fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

export function requiredRatio(sample: Pick<ColourSample, "kind" | "fontSize" | "fontWeight">) {
  if (sample.kind === "mark") return 3;
  return isLargeText(sample.fontSize, sample.fontWeight) ? 3 : 4.5;
}

const hex = (colour: Rgb) =>
  `#${colour.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

/** A box in CSS px. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A scene's canvas averaged to a grid (`SceneMessage` `sample`), and where it is on screen. */
export interface SceneGrid {
  columns: number;
  rows: number;
  /** RGBA bytes, row by row. */
  pixels: readonly number[];
  box: Box;
}

const firstCell = (start: number, origin: number, size: number) =>
  Math.max(0, Math.floor((start - origin) / size));
const lastCell = (end: number, origin: number, size: number, count: number) =>
  Math.min(count - 1, Math.ceil((end - origin) / size) - 1);

/**
 * The grid cells under `box`, each painted over `base` (a scene canvas may be transparent).
 * Empty when the box lies outside the scene.
 */
export function cellsUnder(grid: SceneGrid, box: Box, base: Rgb): Rgb[] {
  const { columns, rows, pixels } = grid;
  if (grid.box.width <= 0 || grid.box.height <= 0) return [];
  const cellWidth = grid.box.width / columns;
  const cellHeight = grid.box.height / rows;
  const fromColumn = firstCell(box.left, grid.box.left, cellWidth);
  const toColumn = lastCell(box.left + box.width, grid.box.left, cellWidth, columns);
  const fromRow = firstCell(box.top, grid.box.top, cellHeight);
  const toRow = lastCell(box.top + box.height, grid.box.top, cellHeight, rows);
  const cells: Rgb[] = [];
  for (let row = fromRow; row <= toRow; row++)
    for (let column = fromColumn; column <= toColumn; column++) {
      const at = (row * columns + column) * 4;
      const [r, g, b, a] = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
      if (r === undefined || g === undefined || b === undefined || a === undefined) continue;
      cells.push(over([r, g, b, a / 255], base));
    }
  return cells;
}

/**
 * One `live-contrast` problem per part that fails anywhere: its worst place, the colours there,
 * and how many places fail, so the agent fixes the part once.
 */
export function contrastProblems(
  samples: readonly ColourSample[],
  scheme: "light" | "dark",
): SuitProblem[] {
  const failing = new Map<string, { sample: ColourSample; measured: Measured; count: number }>();
  for (const sample of samples) {
    const measured = worstContrast(sample);
    if (!measured || measured.ratio >= requiredRatio(sample)) continue;
    const key = `${sample.part}\u0000${sample.kind}`;
    const known = failing.get(key);
    if (!known) failing.set(key, { sample, measured, count: 1 });
    else {
      known.count += 1;
      if (measured.ratio < known.measured.ratio) Object.assign(known, { sample, measured });
    }
  }
  return [...failing.values()].map(({ sample, measured, count }) => {
    const what = sample.kind === "mark" ? "Icons" : "Text";
    const places = count === 1 ? "" : ` (${count} places; this is the worst)`;
    return {
      scheme,
      check: "live-contrast",
      field: sample.part,
      message: `${what} in ${sample.part} shows ${hex(measured.fg)} on ${hex(measured.bg)}, ${measured.ratio.toFixed(2)}:1 as rendered; it needs ${requiredRatio(sample)}:1${places}.`,
    };
  });
}
