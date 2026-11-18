/*
 * The editor's text geometry: one measured monospace width for every plain line, and a real
 * measurement only for a line with tabs or wide characters (where columns stop being cells).
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

/** Columns a character occupies: a tab goes to its stop, wide scripts and emoji take two. */
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
  let at = 0;
  for (const char of text) {
    if (at >= column) break;
    if (char === "\t") visual += size - (visual % size);
    else visual += charWidth(char);
    at += char.length;
  }
  return visual;
}

/** The UTF-16 column at a visual column, clamped to the line's end. */
export function columnAtVisual(text: string, target: number, size = tabSize): number {
  let visual = 0;
  let at = 0;
  for (const char of text) {
    if (visual >= target) return at;
    if (char === "\t") {
      visual += size - (visual % size);
      if (visual > target) return at;
    } else {
      const width = charWidth(char);
      if (visual + width > target) return at;
      visual += width;
    }
    at += char.length;
  }
  return at;
}

/** The UTF-16 column nearest to `x` on a line. */
export function columnAtX(text: string, x: number, cell: number, size = tabSize): number {
  if (x <= 0) return 0;
  let visual = 0;
  let at = 0;
  for (const char of text) {
    const width = char === "\t" ? size - (visual % size) : charWidth(char);
    if ((visual + width / 2) * cell >= x) return at;
    visual += width;
    at += char.length;
  }
  return text.length;
}

const plain = /^[\x20-\x7e]*$/;

/** Whether a line needs no measurement: only printable ASCII, which is one cell each. */
export function isPlain(text: string): boolean {
  return plain.test(text);
}

interface Metre {
  span: HTMLSpanElement;
  measured: Map<string, number>;
}

const metres = new WeakMap<HTMLElement, Metre>();

function metreFor(host: HTMLElement): Metre {
  const known = metres.get(host);
  if (known) return known;
  const span = document.createElement("span");
  span.setAttribute(
    "style",
    "position:absolute;top:0;left:0;visibility:hidden;white-space:pre;pointer-events:none",
  );
  span.style.tabSize = String(tabSize);
  host.append(span);
  const metre = { span, measured: new Map<string, number>() };
  metres.set(host, metre);
  return metre;
}

/** A line's width: cells for plain ASCII, a measured span for tabs and wide characters. */
export function lineWidth(
  host: HTMLElement | null,
  text: string,
  cell: number,
  size = tabSize,
): number {
  if (isPlain(text)) return text.length * cell;
  const estimate = visualColumn(text, text.length, size) * cell;
  if (!host) return estimate;
  const metre = metreFor(host);
  const known = metre.measured.get(text);
  if (known !== undefined) return known;
  metre.span.textContent = text;
  metre.span.style.tabSize = String(size);
  const width = metre.span.getBoundingClientRect().width;
  // A frame with no layout (tests) measures every span at zero: the estimate stands in.
  const value = width > 0 ? width : estimate;
  if (metre.measured.size >= 512) metre.measured.clear();
  metre.measured.set(text, value);
  return value;
}
