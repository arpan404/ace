/*
 * Word wrap for the editor: the visual rows one logical line draws at a text column's width, and
 * where a caret or a click lands among them.
 *
 * Rows never split a grapheme cluster. A row breaks after the last run of spaces or tabs that
 * fits, at the run's first space, and keeps that run at its own end past the row's edge so that
 * every column in it has its own x; the next row resumes at the word. A word longer than the row
 * hard-breaks. One set of ranges serves drawing, selection, hit testing and navigation alike. The
 * line's leading whitespace is never treated as a break and is repeated as the indent of
 * continuation rows, and whitespace after the last word stays on the last row past the row's
 * edge, so the caret can move through it. Plain ASCII over `longLine` wraps by code unit, so a
 * generated file never pays for measuring each character. Nothing here reads the document or the
 * DOM: the view can call it during a render.
 */

import {
  columnAtX,
  graphemes,
  isPlain,
  leastRowCells,
  longLine,
  tabSize,
  visualColumn,
  type Grapheme,
} from "./geometry.ts";

/** One visual row of a logical line. */
export interface WrapRow {
  /** The UTF-16 column the row's text starts at. */
  start: number;
  /** One past the last UTF-16 column the row draws. */
  end: number;
  /** Cells a continuation row indents by, repeating the line's leading whitespace. */
  indent: number;
}

/** A row that takes the whole line: what a line draws when nothing wraps it. */
export const wholeLineRow: readonly WrapRow[] = [
  { start: 0, end: Number.POSITIVE_INFINITY, indent: 0 },
];

/** One row for `text` unchanged, at any width. */
export function wholeRow(text: string): readonly WrapRow[] {
  return text.length === 0
    ? [{ start: 0, end: 0, indent: 0 }]
    : [{ start: 0, end: text.length, indent: 0 }];
}

/** The column after the line's leading whitespace. */
export function leadingEnd(text: string): number {
  let at = 0;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
  return at;
}

/** The leading whitespace's width in cells, which continuation rows repeat as indent. */
export function leadingIndent(text: string): number {
  const end = leadingEnd(text);
  return end === 0 ? 0 : visualColumn(text, end);
}

/**
 * One logical line as the visual rows it draws in `columns` cells. At least one row, always.
 * `Infinity` leaves the line on one row; a narrower width than a row's least text is raised to
 * it, so a caller cannot ask for rows too narrow to hold a character.
 */
export function wrapLine(text: string, columns: number): readonly WrapRow[] {
  if (!Number.isFinite(columns)) return wholeLineRow;
  const width = Math.max(leastRowCells, Math.floor(columns));
  if (text.length === 0) return wholeRow(text);
  if (text.length <= width && isPlain(text)) return wholeRow(text);
  const rows =
    text.length > longLine && isPlain(text)
      ? wrapCodeUnits(text, width)
      : wrapGraphemes(text, width);
  return rows.length ? rows : wholeRow(text);
}

/**
 * The row a UTF-16 column falls on. `before` keeps a column that begins a row at the end of the
 * row before it (a hard break), which is where the caret sits after End or a click past the edge.
 * Row starts are sorted, so a line of a million columns still costs a binary search.
 */
export function rowOfColumn(rows: readonly WrapRow[], column: number, before = false): number {
  let low = 0;
  let high = rows.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = rows[middle];
    if (row !== undefined && row.start <= column) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const row = rows[found];
  if (
    found > 0 &&
    row !== undefined &&
    row.start === column &&
    before &&
    rows[found - 1]?.end === column
  )
    return found - 1;
  return found;
}

/** Whether a column sits at the end of its row and begins the next one: a hard break. */
export function atHardBreak(rows: readonly WrapRow[], row: number, column: number): boolean {
  const next = rows[row + 1];
  return next !== undefined && next.start === column && rows[row]?.end === column;
}

/** The cells from a row's left edge, indent included, to a UTF-16 column on that row. */
export function rowOffset(text: string, row: WrapRow, column: number): number {
  const local = Math.max(0, Math.min(column, row.end) - row.start);
  return row.indent + (local === 0 ? 0 : visualColumn(rowText(text, row), local));
}

/** The UTF-16 column nearest `x` cells from a row's left edge. */
export function columnOnRow(text: string, row: WrapRow, x: number, cell: number): number {
  const local = x - row.indent * cell;
  return row.start + columnAtX(rowText(text, row), local, cell);
}

/** The text one row draws. */
export function rowText(text: string, row: WrapRow): string {
  return text.slice(row.start, Math.min(row.end, text.length));
}

function wrapGraphemes(text: string, width: number): WrapRow[] {
  const parts = graphemes(text);
  const indent = Math.min(leadingIndent(text), Math.max(0, width - leastRowCells));
  const indentEnd = leadingEnd(text);
  // The last cluster that is not whitespace settles every "is the rest all space?" question in
  // one pass, so a very long line never rescans its tail once per row.
  const lastSolid = lastSolidPart(parts);
  const rows: WrapRow[] = [];
  let start = 0;
  let at = 0;
  let first = true;
  while (at < parts.length) {
    const room = first ? width : Math.max(leastRowCells, width - indent);
    let cells = 0;
    let index = at;
    let fit = start;
    let fitAt = at;
    let breakAt = -1;
    let resumeAt = -1;
    let inRun = false;
    while (index < parts.length) {
      const part = parts[index];
      if (!part) break;
      const cell = part.text === "\t" ? tabSize - (cells % tabSize) : part.width;
      if (cells + cell > room && index > at) break;
      cells += cell;
      index++;
      fit = part.end;
      fitAt = index;
      if (isBreak(part.text) && part.start >= indentEnd) {
        // The run's first space is the break; the rest of the run is dropped with it.
        if (!inRun) breakAt = part.start;
        inRun = true;
        let next = index;
        while (next < parts.length && isBreak(parts[next]?.text ?? "")) next++;
        resumeAt = next;
      } else {
        inRun = false;
      }
    }
    let end: number;
    let resume: number;
    if (index >= parts.length) {
      end = text.length;
      resume = parts.length;
    } else if (lastSolid < index) {
      // Whitespace after the last word stays on this row, past its edge, for the caret to reach.
      end = text.length;
      resume = parts.length;
    } else if (breakAt > start && resumeAt > at) {
      // The run stays on the row it broke, past the row's edge: every column in it keeps its x.
      end = parts[resumeAt]?.start ?? text.length;
      resume = resumeAt;
    } else {
      end = fit > start ? fit : (parts[at]?.end ?? text.length);
      resume = end === fit ? fitAt : at + 1;
    }
    if (end <= start) {
      end = parts[at]?.end ?? text.length;
      resume = at + 1;
    }
    rows.push({ start, end, indent: first ? 0 : indent });
    const next = parts[resume];
    start = next ? next.start : text.length;
    at = resume;
    first = false;
  }
  return rows;
}

function wrapCodeUnits(text: string, width: number): WrapRow[] {
  const indent = Math.min(leadingIndent(text), Math.max(0, width - leastRowCells));
  const indentEnd = leadingEnd(text);
  // One pass for the same two questions the grapheme path asks: where the last real character
  // is, and where each row's last space may be. A megabyte of text is never rescanned per row.
  const lastText = lastNonSpace(text);
  const rows: WrapRow[] = [];
  let start = 0;
  while (start < text.length) {
    const room = rows.length === 0 ? width : Math.max(leastRowCells, width - indent);
    let end = Math.min(text.length, start + room);
    if (end < text.length) {
      if (lastText >= end) {
        const space = lastSpaceWithin(text, start, end);
        // The space is kept at this row's end, past its edge, so the caret has a column for it.
        if (space > start && space >= indentEnd) end = space + 1;
      } else {
        end = text.length;
      }
    }
    if (end <= start) end = Math.min(text.length, start + 2);
    rows.push({ start, end, indent: rows.length === 0 ? 0 : indent });
    start = end;
  }
  return rows;
}

/** The index of the last cluster that is not a break, or -1 when every cluster is one. */
function lastSolidPart(parts: readonly Grapheme[]): number {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (!isBreak(parts[index]?.text ?? "")) return index;
  }
  return -1;
}

/** The index of the last character that is not a space, or -1 when only spaces remain. */
function lastNonSpace(text: string): number {
  for (let index = text.length - 1; index >= 0; index--) {
    if (text.charCodeAt(index) !== 32) return index;
  }
  return -1;
}

/** The last space in `[start, end)`, or -1 when that range holds none. */
function lastSpaceWithin(text: string, start: number, end: number): number {
  for (let index = end - 1; index > start; index--) {
    if (text.charCodeAt(index) === 32) return index;
  }
  return -1;
}

function isBreak(cluster: string): boolean {
  return cluster === " " || cluster === "\t";
}
