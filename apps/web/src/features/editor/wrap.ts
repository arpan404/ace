/*
 * Word wrap for the editor: the visual rows one logical line draws at a text column's width, and
 * where a caret or a click lands among them.
 *
 * Rows never split a grapheme cluster. A row breaks after the last run of spaces or tabs that
 * fits, at the run's first space, and keeps that run at its own end past the row's edge so that
 * every column in it has its own x; the next row resumes at the word. A word longer than the row
 * hard-breaks. One set of ranges serves drawing, selection, hit testing and navigation alike. The
 * line's leading whitespace is never treated as a break and is repeated as the indent of
 * continuation rows, and whitespace after the last word stays on the last row past the row's edge,
 * so the caret can move through it. An ASCII line is read one code unit at a time, so a generated
 * file never pays for measuring each character; any other line is read one grapheme cluster at a
 * time, never as a whole array.
 *
 * The rows themselves are materialized on request: measuring a line stores only where each row
 * starts, so a megabyte line costs a few bytes a row rather than a descriptor for every one. A
 * whitespace run is scanned once, by the same break rule for both kinds of text. Nothing here
 * reads the document or the DOM: the view can call it during a render.
 */

import { columnAtX, isPlain, leastRowCells, tabSize, visualColumn } from "./geometry.ts";
import { UnitReader, cellOf, type Unit } from "./wrap-units.ts";

/** One visual row of a logical line. */
export interface WrapRow {
  /** The UTF-16 column the row's text starts at. */
  start: number;
  /** One past the last UTF-16 column the row draws. */
  end: number;
  /** Cells a continuation row indents by, repeating the line's leading whitespace. */
  indent: number;
}

/**
 * A line's visual rows. The line is measured once into row starts; a row is built only when a
 * caller asks for it, and the whole line is never held as one descriptor per row.
 */
export interface WrapRows {
  /** How many rows the line draws. */
  readonly length: number;
  /** The row at `index`, or undefined past the line's rows. */
  at(index: number): WrapRow | undefined;
  [Symbol.iterator](): Iterator<WrapRow>;
}

class LineRows implements WrapRows {
  readonly #starts: Int32Array;
  readonly #lineEnd: number;
  readonly #indent: number;

  constructor(starts: Int32Array, lineEnd: number, indent: number) {
    this.#starts = starts;
    this.#lineEnd = lineEnd;
    this.#indent = indent;
  }

  get length(): number {
    return this.#starts.length;
  }

  at(index: number): WrapRow | undefined {
    const start = this.#starts[index];
    if (start === undefined) return undefined;
    const next = this.#starts[index + 1];
    return {
      start,
      end: next ?? this.#lineEnd,
      indent: index === 0 ? 0 : this.#indent,
    };
  }

  *[Symbol.iterator](): Iterator<WrapRow> {
    for (let index = 0; index < this.#starts.length; index++) {
      const row = this.at(index);
      if (row) yield row;
    }
  }
}

/** No rows: a line inside a folded region draws nothing. */
export const noRows: WrapRows = new LineRows(new Int32Array(0), 0, 0);

/** A row that takes the whole line: what a line draws when nothing wraps it. */
export const wholeLineRow: WrapRows = new LineRows(Int32Array.of(0), Number.POSITIVE_INFINITY, 0);

/** The column after the line's leading whitespace. */
export function leadingEnd(text: string): number {
  let at = 0;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
  return at;
}

/** The leading whitespace's width in cells, which continuation rows repeat as indent. */
export function leadingIndent(text: string): number {
  let cells = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === " ") cells++;
    else if (char === "\t") cells += tabSize - (cells % tabSize);
    else break;
  }
  return cells;
}

/**
 * One logical line as the visual rows it draws in `columns` cells. At least one row, always.
 * `Infinity` leaves the line on one row; a narrower width than a row's least text is raised to
 * it, so a caller cannot ask for rows too narrow to hold a character.
 */
export function wrapLine(text: string, columns: number): WrapRows {
  if (!Number.isFinite(columns)) return wholeLineRow;
  const width = Math.max(leastRowCells, Math.floor(columns));
  if (text.length <= width && isPlain(text)) return wholeLineRow;
  return measure(text, width);
}

/**
 * The row a UTF-16 column falls on. `before` keeps a column that begins a row at the end of the
 * row before it (a hard break), which is where the caret sits after End or a click past the edge.
 * Row starts are sorted, so a line of a million columns still costs a binary search.
 */
export function rowOfColumn(rows: WrapRows, column: number, before = false): number {
  let low = 0;
  let high = rows.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = rows.at(middle);
    if (row !== undefined && row.start <= column) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const row = rows.at(found);
  if (
    found > 0 &&
    row !== undefined &&
    row.start === column &&
    before &&
    rows.at(found - 1)?.end === column
  )
    return found - 1;
  return found;
}

/** Whether a column sits at the end of its row and begins the next one: a hard break. */
export function atHardBreak(rows: WrapRows, row: number, column: number): boolean {
  const next = rows.at(row + 1);
  return next !== undefined && next.start === column && rows.at(row)?.end === column;
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

/** Wheels one line's row starts into shape. */
function measure(text: string, width: number): WrapRows {
  const indentEnd = leadingEnd(text);
  const indent = Math.min(leadingIndent(text), Math.max(0, width - leastRowCells));
  const lastSolid = lastSolidUnit(text);
  const reader = new UnitReader(text);
  const starts: number[] = [0];
  let start = 0;
  let first = true;
  while (start < text.length) {
    const room = first ? width : Math.max(leastRowCells, width - indent);
    const found = rowBreak(reader, start, room, indentEnd, lastSolid, text.length);
    if (found.end >= text.length || found.end <= start) break;
    reader.rewind(found.mark);
    reader.drop();
    starts.push(found.end);
    start = found.end;
    first = false;
  }
  if (starts.length === 1) return wholeLineRow;
  return new LineRows(Int32Array.from(starts), text.length, indent);
}

/**
 * Where the row starting at `start` ends: the last whitespace run that fits, kept whole at the
 * row's end, or a hard break before the unit that no longer fits. The returned mark is where the
 * reader must stand for the next row, which can be earlier than where the scan stopped.
 */
function rowBreak(
  reader: UnitReader,
  start: number,
  room: number,
  indentEnd: number,
  lastSolid: number,
  lineEnd: number,
): { end: number; mark: number } {
  let cells = 0;
  let fit = start;
  let fitMark = reader.mark();
  let breakAt = -1;
  let resumeAt = -1;
  let resumeMark = fitMark;
  let taken = 0;
  const stop = (unit: Unit): { end: number; mark: number } => {
    // Whitespace after the last word stays on this row, past its edge, for the caret to reach.
    if (lastSolid < unit.start) return { end: lineEnd, mark: reader.mark() };
    if (breakAt >= 0) return { end: resumeAt, mark: resumeMark };
    return { end: fit, mark: fitMark };
  };
  for (;;) {
    const unit = reader.peek();
    if (!unit) return { end: lineEnd, mark: reader.mark() };
    if (unit.space && unit.start >= indentEnd && unit.start > start) {
      // The reader reuses its unit object, so the run's own values are read before it moves on.
      const runStart = unit.start;
      if (cells + cellOf(unit, cells) > room && taken > 0) return stop(unit);
      // One pass over the whole run: the row keeps it at its end, and the next row starts after
      // it, so no unit of it is ever read twice.
      let runEnd = runStart;
      while (true) {
        const part = reader.peek();
        if (!part || !part.space) break;
        cells += cellOf(part, cells);
        runEnd = part.end;
        reader.take();
        taken++;
      }
      const mark = reader.mark();
      if (runEnd >= lineEnd || lastSolid < runStart) return { end: lineEnd, mark };
      if (cells > room) return { end: runEnd, mark };
      breakAt = runStart;
      resumeAt = runEnd;
      resumeMark = mark;
      fit = runEnd;
      fitMark = mark;
      continue;
    }
    if (cells + cellOf(unit, cells) > room && taken > 0) return stop(unit);
    cells += cellOf(unit, cells);
    fit = unit.end;
    reader.take();
    taken++;
    fitMark = reader.mark();
  }
}

/** The start of the last code unit that is not a space or a tab, or -1 when all are blanks. */
function lastSolidUnit(text: string): number {
  for (let at = text.length - 1; at >= 0; at--) {
    const code = text.charCodeAt(at);
    if (code !== 32 && code !== 9) return at;
  }
  return -1;
}
