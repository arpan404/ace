import { indentOf } from "./folding.ts";

/*
 * Sticky scroll: the headers of the indentation blocks (the same regions folding uses) that hold
 * the line at the top of the view, pinned above the text so the person sees which function or
 * block they are in. Only lines above the top line are read, and no more than `lookback` of them,
 * so a scroll or an edit costs the same in any file.
 */

/** How many blank lines below a blank top line are read for the depth it sits at. */
const blankLookout = 100;

/**
 * The header lines of the blocks enclosing `top`, outermost first, each above `top`. A block's
 * header is a line shallower than everything between it and `top`; at most `max` are kept, the
 * innermost.
 */
export function stickyHeaders(options: {
  lineAt: (line: number) => string;
  lineCount: number;
  top: number;
  indentSize: number;
  max: number;
  lookback: number;
}): number[] {
  const { lineAt, lineCount, top, indentSize, max, lookback } = options;
  if (max <= 0 || top <= 0 || top >= lineCount) return [];
  let depth = indentOf(lineAt(top), indentSize);
  for (
    let next = top + 1;
    depth === undefined && next < Math.min(lineCount, top + blankLookout);
    next++
  )
    depth = indentOf(lineAt(next), indentSize);
  if (depth === undefined) return [];
  const headers: number[] = [];
  const stop = Math.max(0, top - lookback);
  for (let line = top - 1; line >= stop && depth > 0; line--) {
    const indent = indentOf(lineAt(line), indentSize);
    if (indent === undefined || indent >= depth) continue;
    headers.push(line);
    depth = indent;
  }
  // Read upwards: innermost first. Keep the innermost `max`, shown outermost first.
  return headers.slice(0, max).toReversed();
}

/** The most headers pinned at once, and never more than a third of the view's rows. */
export const stickyMax = 5;
/** How far above the top line the search for headers reads. */
export const stickyLookback = 1000;

/**
 * The headers to pin for a view whose first row is `topRow`. The pinned rows cover the lines
 * under them, so the line they are read for is the one just below the pinned rows: the search
 * runs once more from there.
 */
export function pinnedHeaders(options: {
  lineAt: (line: number) => string;
  lineCount: number;
  /** The logical line drawn at a visual row. */
  lineOfRow: (row: number) => number;
  topRow: number;
  viewRows: number;
  indentSize: number;
}): number[] {
  const { lineAt, lineCount, lineOfRow, topRow, viewRows, indentSize } = options;
  const max = Math.min(stickyMax, Math.floor(viewRows / 3));
  const read = (top: number) =>
    stickyHeaders({ lineAt, lineCount, top, indentSize, max, lookback: stickyLookback });
  const first = read(lineOfRow(topRow));
  if (first.length === 0) return first;
  const below = lineOfRow(topRow + first.length);
  return read(below).filter((line) => line < below);
}
