import { visualColumn } from "./geometry.ts";

/*
 * Indentation-based folding, as VS Code's default: a region starts at a line whose next
 * non-blank line is indented deeper, and runs to the last line before the next non-blank line
 * that is not. The closing line (a `}`) stays visible. Questions about one line read only the
 * lines near it; listing every region (fold all) is one pass, run only when asked.
 */

/** A folded or foldable region: `start` is the line that stays visible, `end` the last hidden. */
export interface FoldRange {
  start: number;
  end: number;
}

type Lines = (line: number) => string;

/** A line's indentation in cells, or undefined for a blank line. */
function indentOf(text: string, size: number): number | undefined {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index++;
  return index === text.length ? undefined : visualColumn(text, index, size);
}

/** How many blank lines a foldable check looks past for the next line with text. */
const blankLookout = 100;

/** Whether `line` starts a region: the next line with text is indented deeper. */
export function isFoldStart(lineAt: Lines, lineCount: number, line: number, size: number): boolean {
  const own = indentOf(lineAt(line), size);
  if (own === undefined) return false;
  for (let next = line + 1; next < Math.min(lineCount, line + 1 + blankLookout); next++) {
    const indent = indentOf(lineAt(next), size);
    if (indent !== undefined) return indent > own;
  }
  return false;
}

/** The region starting at `line`, if it starts one; reads the region's own lines. */
export function foldAt(
  lineAt: Lines,
  lineCount: number,
  line: number,
  size: number,
): FoldRange | undefined {
  if (!isFoldStart(lineAt, lineCount, line, size)) return undefined;
  const own = indentOf(lineAt(line), size) ?? 0;
  let end = line;
  for (let next = line + 1; next < lineCount; next++) {
    const indent = indentOf(lineAt(next), size);
    if (indent === undefined) continue;
    if (indent <= own) break;
    end = next;
  }
  return end > line ? { start: line, end } : undefined;
}

/** The innermost region holding `line` (or starting on it), looking up from it. */
export function foldAround(
  lineAt: Lines,
  lineCount: number,
  line: number,
  size: number,
): FoldRange | undefined {
  const own = foldAt(lineAt, lineCount, line, size);
  if (own) return own;
  let indent = indentOf(lineAt(line), size) ?? Number.POSITIVE_INFINITY;
  // Only a shallower line above can hold this one: each step up is the next enclosing level.
  for (let start = line - 1; start >= 0 && indent > 0; start--) {
    const above = indentOf(lineAt(start), size);
    if (above === undefined || above >= indent) continue;
    const range = foldAt(lineAt, lineCount, start, size);
    if (range && range.end >= line) return range;
    indent = above;
  }
  return undefined;
}

/** Every region in the document, in one pass with a stack of open indents. */
export function allFolds(lineAt: Lines, lineCount: number, size: number): FoldRange[] {
  const out: FoldRange[] = [];
  const open: { line: number; indent: number; last: number }[] = [];
  let previous: { line: number; indent: number } | undefined;
  for (let line = 0; line < lineCount; line++) {
    const indent = indentOf(lineAt(line), size);
    if (indent === undefined) continue;
    while (open.length && (open.at(-1)?.indent ?? 0) >= indent) {
      const done = open.pop();
      if (done && done.last > done.line) out.push({ start: done.line, end: done.last });
    }
    if (previous && indent > previous.indent)
      open.push({ line: previous.line, indent: previous.indent, last: line });
    for (const region of open) region.last = line;
    previous = { line, indent };
  }
  for (const done of open)
    if (done.last > done.line) out.push({ start: done.line, end: done.last });
  return out.toSorted((a, b) => a.start - b.start);
}

/** The line ranges the folds hide, `[from, to)`, nested folds merged. */
export function hiddenRanges(folds: readonly FoldRange[]): { from: number; to: number }[] {
  const sorted = folds.toSorted((a, b) => a.start - b.start);
  const out: { from: number; to: number }[] = [];
  for (const fold of sorted) {
    const from = fold.start + 1;
    const to = fold.end + 1;
    const last = out.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}
