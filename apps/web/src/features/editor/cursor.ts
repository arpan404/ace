import type { Position, Selection } from "@ace/editor";

/*
 * Cursor arithmetic on plain text, used by the editor's keys and pointer: word boundaries,
 * smart Home, line and word selections, and stepping by a character.
 */

const wordChar = /[\p{L}\p{N}_$]/u;
const graphemes =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export function comparePositions(a: Position, b: Position): number {
  return a.line === b.line ? a.column - b.column : a.line - b.line;
}

/** The selection's endpoints in document order. */
export function ordered(selection: Selection): { start: Position; end: Position } {
  return comparePositions(selection.anchor, selection.head) <= 0
    ? { start: selection.anchor, end: selection.head }
    : { start: selection.head, end: selection.anchor };
}

export function caret(line: number, column: number): Selection {
  return { anchor: { line, column }, head: { line, column } };
}

/** The first non-blank column, which smart Home goes to before the line's start. */
export function firstNonBlank(text: string): number {
  return text.length - text.trimStart().length;
}

/** Home: the first non-blank column, or the line's start when already there. */
export function smartHome(text: string, column: number): number {
  const first = firstNonBlank(text);
  return column === first ? 0 : first;
}

function codePoints(text: string): { char: string; start: number }[] {
  const points: { char: string; start: number }[] = [];
  let at = 0;
  for (const char of text) {
    points.push({ char, start: at });
    at += char.length;
  }
  return points;
}

/** One character before `column`, keeping surrogate pairs and joined emoji together. */
export function stepBack(text: string, column: number): number {
  if (column <= 0) return 0;
  if (graphemes) {
    let previous = 0;
    for (const part of graphemes.segment(text)) {
      if (part.index >= column) break;
      previous = part.index;
    }
    return previous;
  }
  const points = codePoints(text);
  return points.findLast((point) => point.start < column)?.start ?? 0;
}

/** One character after `column`. */
export function stepForward(text: string, column: number): number {
  if (column >= text.length) return text.length;
  if (graphemes) {
    for (const part of graphemes.segment(text)) {
      if (part.index > column) return part.index;
    }
    return text.length;
  }
  const points = codePoints(text);
  return points.find((point) => point.start > column)?.start ?? text.length;
}

/** The start of the word before `column`, skipping punctuation and whitespace. */
export function previousWord(text: string, column: number): number {
  let at = column;
  while (at > 0) {
    const before = stepBack(text, at);
    if (isWord(text.slice(before, at))) break;
    at = before;
  }
  while (at > 0) {
    const before = stepBack(text, at);
    if (!isWord(text.slice(before, at))) break;
    at = before;
  }
  return at;
}

/** The end of the word after `column`, with the punctuation run before it. */
export function nextWord(text: string, column: number): number {
  let at = column;
  while (at < text.length) {
    const after = stepForward(text, at);
    if (isWord(text.slice(at, after))) break;
    at = after;
  }
  while (at < text.length) {
    const after = stepForward(text, at);
    if (!isWord(text.slice(at, after))) break;
    at = after;
  }
  return at;
}

function isWord(char: string): boolean {
  return wordChar.test(char);
}

/** The word under `column` for a double-click, or the caret when there is none. */
export function wordAt(text: string, column: number): { start: number; end: number } {
  const capped = Math.min(column, text.length);
  if (!text) return { start: 0, end: 0 };
  // A click at the end of a word still selects it, as a double-click at its edge does.
  const point = Math.min(capped, Math.max(0, text.length - 1));
  const inside = isWord(text[point] ?? "");
  const start = inside ? previousWord(text, point + 1) : point;
  const end = inside ? nextWord(text, point) : point;
  return { start, end: Math.max(start, end) };
}

/** A triple-click's line, including its line break when one follows. */
export function lineSelection(line: number, text: string, hasNext: boolean): Selection {
  return {
    anchor: { line, column: 0 },
    head: hasNext ? { line: line + 1, column: 0 } : { line, column: text.length },
  };
}

/** Where the caret lands when `column` is past a shorter line. */
export function clampColumn(column: number, text: string): number {
  return Math.max(0, Math.min(column, text.length));
}

/** Whether every selection is a caret, the state a Backspace or a character key edits. */
export function allCollapsed(selections: readonly Selection[]): boolean {
  return selections.every(
    (selection) =>
      selection.anchor.line === selection.head.line &&
      selection.anchor.column === selection.head.column,
  );
}

/** The document's last position, for Select All and Cmd+End. */
export function documentEnd(lineCount: number, lastLine: string): Position {
  return { line: Math.max(0, lineCount - 1), column: lastLine.length };
}

/** Replaces the selection at `index`, keeping every other cursor. */
export function withHead(
  selections: readonly Selection[],
  index: number,
  head: Position,
  extend: boolean,
): Selection[] {
  return selections.map((selection, at) => {
    if (at !== index) return selection;
    return { anchor: extend ? selection.anchor : head, head };
  });
}

/** Moves every caret by `move`, the way VS Code moves its multiple cursors together. */
export function moveAll(
  selections: readonly Selection[],
  move: (position: Position) => Position,
  extend: boolean,
): Selection[] {
  return selections.map((selection) => ({
    anchor: extend ? selection.anchor : move(selection.head),
    head: move(selection.head),
  }));
}

/** The 1-based line span every non-empty selection covers, or undefined when all are carets. */
export function selectedLineSpan(selections: readonly Selection[]): string | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const selection of selections) {
    if (
      selection.anchor.line === selection.head.line &&
      selection.anchor.column === selection.head.column
    )
      continue;
    start = Math.min(start, selection.anchor.line, selection.head.line);
    end = Math.max(end, selection.anchor.line, selection.head.line);
  }
  return end >= 0 ? `${start + 1}-${end + 1}` : undefined;
}

/** Whether two cursor lists are the same cursors in the same order. */
export function sameSelections(a: readonly Selection[], b: readonly Selection[]): boolean {
  return (
    a.length === b.length &&
    a.every((one, index) => {
      const other = b[index];
      return (
        !!other &&
        comparePositions(one.anchor, other.anchor) === 0 &&
        comparePositions(one.head, other.head) === 0
      );
    })
  );
}
