/*
 * Word wrap for the editor: the visual rows one logical line draws at a text column's width, and
 * where a caret or a click lands among them.
 *
 * Rows never split a grapheme cluster. A row breaks at the last run of spaces or tabs that fits,
 * dropping that run from its text so the next row resumes at the word; a word longer than the row
 * hard-breaks. Continuation rows repeat the line's leading whitespace as indent. Lines longer
 * than `longLine` wrap by code unit, so a generated file never pays for measuring each character.
 * Nothing here reads the document or the DOM: the view can call it during a render.
 */

import {
  columnAtX,
  graphemes,
  isPlain,
  leastRowCells,
  longLine,
  tabSize,
  visualColumn,
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
const wholeLineRow: readonly WrapRow[] = [{ start: 0, end: Number.POSITIVE_INFINITY, indent: 0 }];

/** One row for `text` unchanged, at any width. */
export function wholeRow(text: string): readonly WrapRow[] {
  return text.length === 0
    ? [{ start: 0, end: 0, indent: 0 }]
    : [{ start: 0, end: text.length, indent: 0 }];
}

/** The leading whitespace's width in cells, which continuation rows repeat as indent. */
export function leadingIndent(text: string): number {
  let at = 0;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
  return at === 0 ? 0 : visualColumn(text, at);
}

/**
 * One logical line as the visual rows it draws in `columns` cells. At least one row, always;
 * `Infinity` (or a non-finite value) leaves the line on one row.
 */
export function wrapLine(text: string, columns: number): readonly WrapRow[] {
  if (!Number.isFinite(columns) || columns <= 0) return wholeLineRow;
  const width = Math.max(1, Math.floor(columns));
  if (text.length === 0) return wholeRow(text);
  if (text.length <= width && isPlain(text)) return wholeRow(text);
  const rows = text.length > longLine ? wrapCodeUnits(text, width) : wrapGraphemes(text, width);
  return rows.length ? rows : wholeRow(text);
}

/** The row a UTF-16 column falls on: the last row that starts at or before it. */
export function rowOfColumn(rows: readonly WrapRow[], column: number): number {
  for (let index = rows.length - 1; index > 0; index--) {
    if (rows[index].start <= column) return index;
  }
  return 0;
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
    while (index < parts.length) {
      const part = parts[index];
      const cell = part.text === "\t" ? tabSize - (cells % tabSize) : part.width;
      if (cells + cell > room && index > at) break;
      cells += cell;
      index++;
      fit = part.end;
      fitAt = index;
      if (part.text === " " || part.text === "\t") {
        let next = index;
        while (next < parts.length && isBreak(parts[next].text)) next++;
        breakAt = part.start;
        resumeAt = next;
      }
    }
    let end: number;
    let resume: number;
    if (index >= parts.length) {
      end = text.length;
      resume = parts.length;
    } else if (breakAt > start && resumeAt > at) {
      end = breakAt;
      resume = resumeAt;
    } else {
      end = fit > start ? fit : parts[at].end;
      resume = end === fit ? fitAt : at + 1;
    }
    if (end <= start) {
      end = parts[at].end;
      resume = at + 1;
    }
    rows.push({ start, end, indent: first ? 0 : indent });
    start = resume < parts.length ? parts[resume].start : text.length;
    at = resume;
    first = false;
  }
  return rows;
}

function wrapCodeUnits(text: string, width: number): WrapRow[] {
  const indent = Math.min(leadingIndent(text), Math.max(0, width - leastRowCells));
  const rows: WrapRow[] = [];
  let start = 0;
  while (start < text.length) {
    const room = rows.length === 0 ? width : Math.max(leastRowCells, width - indent);
    let end = Math.min(text.length, start + room);
    if (end < text.length) {
      if (isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) end--;
      const space = text.lastIndexOf(" ", end - 1);
      if (space > start) end = space;
    }
    if (end <= start) end = Math.min(text.length, start + 2);
    rows.push({ start, end, indent: rows.length === 0 ? 0 : indent });
    start = end;
    while (start < text.length && text[start] === " ") start++;
  }
  return rows;
}

function isBreak(cluster: string): boolean {
  return cluster === " " || cluster === "\t";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
