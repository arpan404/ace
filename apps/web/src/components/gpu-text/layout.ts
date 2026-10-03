/*
 * Pure layout for the GPU text view: which lines are in view and one textured quad per glyph
 * or line background. The GPU backends only upload and draw what this returns, so the view's
 * per-frame work is proportional to the screen, never to the document.
 */

export type Tone = "plain" | "muted" | "add" | "del";
export interface TextLine {
  /** Gutter text (line numbers), drawn muted. */
  gutter: string;
  text: string;
  /** Background band and ink of the line. */
  band: "none" | "add" | "del" | "fold";
  ink: Tone;
}
export interface Metrics {
  /** CSS px. */
  lineHeight: number;
  cellWidth: number;
  /** Columns reserved for the gutter. */
  gutterCells: number;
}
export interface View {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
}
/** Where a glyph lives in the atlas, in texture coordinates. */
export interface GlyphRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
/** Palette indices; the backends map them to colours from the theme. */
export const palette = ["plain", "muted", "add", "del", "addBand", "delBand", "foldBand"] as const;
export type PaletteName = (typeof palette)[number];

/** Floats per quad: x, y, w, h (CSS px), u0, v0, u1, v1, palette index. */
export const quadFloats = 9;

export interface Frame {
  quads: Float32Array;
  count: number;
  first: number;
  last: number;
}

const tabWidth = 4;
/** Text as the cells it occupies: tabs expand to the next stop; other controls show as space. */
export function cells(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\t") out += " ".repeat(tabWidth - (out.length % tabWidth));
    else out += char < " " ? " " : char;
  }
  return out;
}

export function totalHeight(lines: number, metrics: Metrics): number {
  return lines * metrics.lineHeight;
}

/**
 * Quads for the lines visible in `view`. `glyph` places a character in the atlas (undefined
 * for blanks); `solid` is a fully opaque atlas texel used for bands.
 */
export function layoutFrame(
  lines: readonly TextLine[],
  view: View,
  metrics: Metrics,
  glyph: (char: string) => GlyphRect | undefined,
  solid: GlyphRect,
  into?: Float32Array,
): Frame {
  const first = Math.max(0, Math.floor(view.scrollTop / metrics.lineHeight));
  const last = Math.min(
    lines.length,
    Math.ceil((view.scrollTop + view.height) / metrics.lineHeight),
  );
  const firstCol = Math.max(0, Math.floor(view.scrollLeft / metrics.cellWidth));
  const columns = Math.ceil(view.width / metrics.cellWidth) + 1;
  const textColumns = Math.max(0, columns - metrics.gutterCells);
  const budget = (last - first) * (columns + 1);
  const quads =
    into && into.length >= budget * quadFloats ? into : new Float32Array(budget * quadFloats);
  let count = 0;
  const push = (x: number, y: number, w: number, h: number, rect: GlyphRect, color: number) => {
    const at = count * quadFloats;
    quads[at] = x;
    quads[at + 1] = y;
    quads[at + 2] = w;
    quads[at + 3] = h;
    quads[at + 4] = rect.u0;
    quads[at + 5] = rect.v0;
    quads[at + 6] = rect.u1;
    quads[at + 7] = rect.v1;
    quads[at + 8] = color;
    count++;
  };
  const gutterWidth = metrics.gutterCells * metrics.cellWidth;
  for (let index = first; index < last; index++) {
    const line = lines[index];
    if (!line) continue;
    const y = index * metrics.lineHeight - view.scrollTop;
    if (line.band !== "none")
      push(0, y, view.width, metrics.lineHeight, solid, palette.indexOf(`${line.band}Band`));
    const gutter = line.gutter.slice(0, metrics.gutterCells);
    for (let column = 0; column < gutter.length; column++) {
      const rect = glyph(gutter[column] ?? " ");
      if (rect) push(column * metrics.cellWidth, y, metrics.cellWidth, metrics.lineHeight, rect, 1);
    }
    const text = cells(line.text);
    const ink = palette.indexOf(line.ink);
    const end = Math.min(text.length, firstCol + textColumns);
    for (let column = firstCol; column < end; column++) {
      const rect = glyph(text[column] ?? " ");
      if (!rect) continue;
      const x = gutterWidth + (column - firstCol) * metrics.cellWidth;
      push(x, y, metrics.cellWidth, metrics.lineHeight, rect, ink);
    }
  }
  return { quads, count, first, last };
}

/** Which renderer a text view uses: the GPU only for documents big enough to need it. */
export function pickRenderer(options: {
  lines: number;
  enabled: boolean;
  webgpu: boolean;
  webgl2: boolean;
  /** Below this many lines the DOM view is used. */
  threshold: number;
}): "webgpu" | "webgl2" | "dom" {
  if (!options.enabled || options.lines < options.threshold) return "dom";
  if (options.webgpu) return "webgpu";
  if (options.webgl2) return "webgl2";
  return "dom";
}
