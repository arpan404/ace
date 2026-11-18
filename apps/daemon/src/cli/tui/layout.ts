import { stripVTControlCharacters } from "node:util";

/**
 * Display width, wrapping and cutting for terminal lines (ADR 0178 §9). Pure. Width counts
 * terminal cells: East Asian wide and fullwidth characters and emoji take two, combining marks
 * and joiners none, and colour sequences none.
 */

/** Ranges of code points a terminal draws two cells wide (East Asian Wide and Fullwidth). */
const wide: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function isWide(code: number): boolean {
  let low = 0;
  let high = wide.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = wide[middle];
    if (!range) return false;
    if (code < range[0]) high = middle - 1;
    else if (code > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

const zeroWidth = /^(?:\p{Mn}|\p{Me}|\p{Cf}|[\u200b-\u200f]|[\ufe00-\ufe0f])+$/u;
const pictographic = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The cells one grapheme cluster takes. */
export function graphemeWidth(cluster: string): number {
  const code = cluster.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (zeroWidth.test(cluster)) return 0;
  // An emoji sequence (ZWJ family, a flag pair, a symbol asked to draw as emoji) is two cells.
  if (cluster.includes("‍") || cluster.includes("️")) return 2;
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return 2;
  if (isWide(code)) return 2;
  if (code > 0x1f000 && pictographic.test(cluster)) return 2;
  return 1;
}

/** The grapheme clusters of `text`, so a cut never splits an emoji or a letter from its mark. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** The cells `text` takes on a terminal, ignoring colour and other control sequences. */
export function textWidth(text: string): number {
  const plain = stripVTControlCharacters(text);
  // Plain ASCII, the common case, is one cell a character.
  if (/^[\x20-\x7e]*$/.test(plain)) return plain.length;
  let width = 0;
  for (const cluster of graphemes(plain)) width += graphemeWidth(cluster);
  return width;
}

/** `text` cut to `width` cells from the end, with "…" where it was cut. */
export function cutEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const cluster of graphemes(text)) {
    const cells = graphemeWidth(cluster);
    if (used + cells > width - 1) break;
    out += cluster;
    used += cells;
  }
  return `${out}…`;
}

/**
 * `text` cut to `width` cells by taking out its middle, so both its start and its distinctive
 * end stay: "bun --bun x vitest run …relay.device.process.test.ts" style.
 */
export function cutMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  if (width < 3) return cutEnd(text, width);
  const clusters = graphemes(text);
  const room = width - 1;
  const tailRoom = Math.floor(room / 2);
  const headRoom = room - tailRoom;
  let head = "";
  let used = 0;
  for (const cluster of clusters) {
    const cells = graphemeWidth(cluster);
    if (used + cells > headRoom) break;
    head += cluster;
    used += cells;
  }
  let tail = "";
  used = 0;
  for (let index = clusters.length - 1; index >= 0; index--) {
    const cluster = clusters[index] ?? "";
    const cells = graphemeWidth(cluster);
    if (used + cells > tailRoom) break;
    tail = cluster + tail;
    used += cells;
  }
  return `${head}…${tail}`;
}

/** `text` padded with spaces to `width` cells (never cut). */
export function padEnd(text: string, width: number): string {
  const missing = width - textWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** `text` padded on the left to `width` cells (never cut). */
export function padStart(text: string, width: number): string {
  const missing = width - textWidth(text);
  return missing > 0 ? " ".repeat(missing) + text : text;
}

/** `text` exactly `width` cells: cut at the end or padded. */
export function fit(text: string, width: number): string {
  return padEnd(cutEnd(text, width), width);
}

/**
 * `text` wrapped to lines of at most `width` cells, breaking at spaces and breaking a word
 * longer than a line where it must. Newlines in `text` start new lines; blank lines stay.
 */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const expanded = paragraph.replace(/\t/g, "  ");
    if (textWidth(expanded) <= room) {
      lines.push(expanded.trimEnd());
      continue;
    }
    let line = "";
    let used = 0;
    for (const word of expanded.split(/(\s+)/)) {
      if (!word) continue;
      const cells = textWidth(word);
      if (/^\s+$/.test(word)) {
        if (used && used + cells <= room) {
          line += word;
          used += cells;
        } else if (used) {
          lines.push(line.trimEnd());
          line = "";
          used = 0;
        }
        continue;
      }
      if (used + cells <= room) {
        line += word;
        used += cells;
        continue;
      }
      if (used) lines.push(line.trimEnd());
      line = "";
      used = 0;
      // A word longer than the line breaks where the line ends.
      for (const cluster of graphemes(word)) {
        const size = graphemeWidth(cluster);
        if (used + size > room) {
          lines.push(line);
          line = "";
          used = 0;
        }
        line += cluster;
        used += size;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Text a provider or person wrote, safe to draw: no control or escape sequences survive. */
export function safeText(text: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- terminal output never carries controls.
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
