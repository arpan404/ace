import type { Range } from "@ace/editor";
import { visualColumn } from "./geometry.ts";

/*
 * What the decoration layer draws, worked out for the visible lines only: other occurrences of
 * the word at the caret, indentation guide levels and whitespace marks. Each function reads the
 * lines on screen (plus a bounded look past the edge for guides), never the whole document.
 */

const wordChar = /[\p{L}\p{N}_]/u;

/** The word the caret touches (inside it or just after it), if any. */
export function wordAtCaret(
  text: string,
  column: number,
): { start: number; end: number } | undefined {
  let start = column;
  let end = column;
  while (start > 0 && wordChar.test(text[start - 1] ?? "")) start--;
  while (end < text.length && wordChar.test(text[end] ?? "")) end++;
  return end > start ? { start, end } : undefined;
}

/** The most occurrences one view highlights. */
const occurrenceCap = 2_000;

/** Whole-word occurrences of `word` on lines `first..last`, in order. */
export function wordOccurrences(
  lineAt: (line: number) => string,
  first: number,
  last: number,
  word: string,
): Range[] {
  const out: Range[] = [];
  if (!word) return out;
  for (let line = first; line < last; line++) {
    const text = lineAt(line);
    let from = text.indexOf(word);
    while (from !== -1) {
      const end = from + word.length;
      const before = text[from - 1];
      const after = text[end];
      if (!(before && wordChar.test(before)) && !(after && wordChar.test(after)))
        out.push({ start: { line, column: from }, end: { line, column: end } });
      if (out.length >= occurrenceCap) return out;
      from = text.indexOf(word, end);
    }
  }
  return out;
}

/** How many cells of indentation a line has, or undefined for a blank line. */
function indentCells(text: string, size: number): number | undefined {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index++;
  if (index === text.length) return undefined;
  return visualColumn(text, index, size);
}

/** How far past the visible edge a blank line looks for the indentation around it. */
const guideLookout = 50;

/**
 * The indent guides each line in `first..last` draws: one per indent step its text sits inside.
 * A blank line takes the smaller indentation of the lines around it, so a guide runs through it.
 */
export function guideLevels(
  lineAt: (line: number) => string,
  first: number,
  last: number,
  lineCount: number,
  size: number,
): number[] {
  const step = Math.max(1, size);
  const levels: number[] = [];
  const cells = (line: number) => indentCells(lineAt(line), step);
  const nearest = (line: number, delta: 1 | -1) => {
    for (
      let at = line + delta, seen = 0;
      at >= 0 && at < lineCount && seen < guideLookout;
      at += delta, seen++
    ) {
      const found = cells(at);
      if (found !== undefined) return found;
    }
    return 0;
  };
  for (let line = first; line < last; line++) {
    const own = cells(line);
    const width = own ?? Math.min(nearest(line, -1), nearest(line, 1));
    levels.push(Math.ceil(width / step));
  }
  return levels;
}

/** The most whitespace marks one row draws. */
const markCap = 500;

/** The spaces and tabs in `text[from, to)`, by UTF-16 column. */
export function whitespaceMarks(
  text: string,
  from: number,
  to: number,
): { column: number; tab: boolean }[] {
  const marks: { column: number; tab: boolean }[] = [];
  for (let column = from; column < to && marks.length < markCap; column++) {
    const char = text[column];
    if (char === " " || char === "\t") marks.push({ column, tab: char === "\t" });
  }
  return marks;
}
