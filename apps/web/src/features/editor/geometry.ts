/*
 * The editor's text geometry: one measured monospace width for every plain line, and a real
 * measurement for a line with tabs or wide characters (where columns stop being cells).
 *
 * Every value here is in CSS pixels inside the editor's text column; the gutter is added by the
 * caller. Columns are UTF-16 offsets, the unit the document and the DOM use.
 */

/** The line pitch of the Files viewer (13px mono on 22px), shared with the gutter. */
export const lineHeight = 22;
/** One indent step, matching the checkout's own style. */
export const tabSize = 2;
/** Used where nothing can be measured (tests, a detached element, an early first frame). */
export const fallbackCharWidth = 7.8;

const widths = new Map<string, number>();

/** Forgets every measured font width; a web font arrived or the display density changed. */
export function clearMeasurements(): void {
  widths.clear();
}

/** The width of one monospace cell for `font`, measured once and kept by the font string. */
export function charWidthFor(font: string): number {
  const known = widths.get(font);
  if (known !== undefined) return known;
  const span = document.createElement("span");
  span.textContent = "0".repeat(64);
  span.setAttribute(
    "style",
    `position:absolute;visibility:hidden;white-space:pre;font:${font};letter-spacing:0`,
  );
  document.body.append(span);
  const width = span.getBoundingClientRect().width / 64;
  span.remove();
  const value = width > 0.5 && Number.isFinite(width) ? width : fallbackCharWidth;
  widths.set(font, value);
  return value;
}

/** The gutter's room for `lines` line numbers: right-aligned numbers and their padding. */
export function gutterWidth(lines: number): number {
  return Math.max(48, String(Math.max(1, lines)).length * 8 + 24);
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** One user-perceived character: its UTF-16 span and the cells it takes. */
export interface Grapheme {
  text: string;
  start: number;
  end: number;
  width: number;
}

/** A string's grapheme clusters, so an emoji joined from five code points stays one cell pair. */
export function graphemes(text: string): Grapheme[] {
  if (!segmenter) {
    return Array.from(text).map((char, index) => ({
      text: char,
      start: index,
      end: index + char.length,
      width: charWidth(char),
    }));
  }
  const out: Grapheme[] = [];
  for (const part of segmenter.segment(text)) {
    const value = part.segment;
    out.push({
      text: value,
      start: part.index,
      end: part.index + value.length,
      width: clusterWidth(value),
    });
  }
  return out;
}

function clusterWidth(cluster: string): number {
  let width = 0;
  for (const char of cluster) {
    const cells = charWidth(char);
    if (cells === 2) return 2;
    if (cells === 1) width = 1;
  }
  return width;
}

/** Columns a character occupies: wide scripts and emoji take two, combining marks none. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 9) return 0;
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** The visual column a UTF-16 column lands on, with tabs expanded to `size` stops. */
export function visualColumn(text: string, column: number, size = tabSize): number {
  let visual = 0;
  for (const grapheme of graphemes(text)) {
    if (grapheme.start >= column) break;
    if (grapheme.text === "\t") visual += size - (visual % size);
    else visual += grapheme.width;
  }
  return visual;
}

/** The UTF-16 column at a visual column, clamped to the line's end. */
export function columnAtVisual(text: string, target: number, size = tabSize): number {
  let visual = 0;
  for (const grapheme of graphemes(text)) {
    if (visual >= target) return grapheme.start;
    if (grapheme.text === "\t") {
      visual += size - (visual % size);
      if (visual > target) return grapheme.start;
    } else {
      if (visual + grapheme.width > target) return grapheme.start;
      visual += grapheme.width;
    }
  }
  return text.length;
}

/** The UTF-16 column nearest to `x` on a line. */
export function columnAtX(text: string, x: number, cell: number, size = tabSize): number {
  if (x <= 0) return 0;
  let visual = 0;
  for (const grapheme of graphemes(text)) {
    const width = grapheme.text === "\t" ? size - (visual % size) : grapheme.width;
    if ((visual + width / 2) * cell >= x) return grapheme.start;
    visual += width;
  }
  return text.length;
}

const plain = /^[\x20-\x7e]*$/;

/** Whether a line needs no measurement: only printable ASCII, which is one cell each. */
export function isPlain(text: string): boolean {
  return plain.test(text);
}

/** A line's width from the cell estimate; plain ASCII is exactly one cell per character. */
export function lineWidth(text: string, cell: number, size = tabSize): number {
  if (isPlain(text)) return text.length * cell;
  return visualColumn(text, text.length, size) * cell;
}

/**
 * A rendered line span's width, from a DOM Range. This is the real measurement for non-ASCII
 * text, whose glyphs a monospace cell count cannot predict (ligatures, emoji, fallbacks).
 */
export function measureElement(element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  // jsdom has no layout: the caller falls back to the cell estimate.
  if (typeof range.getBoundingClientRect !== "function") return 0;
  const rect = range.getBoundingClientRect();
  const first = range.getClientRects()[0];
  return rect.width || first?.width || 0;
}
