import type { Position, Selection } from "@ace/editor";
import { isBefore, type Affinity } from "./affinity.ts";
import { ordered } from "./cursor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { rowOffset, rowOfColumn } from "./wrap.ts";

/** The composing string, drawn at every caret until the IME commits it. */
export interface Composing {
  text: string;
}

interface Box {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a position sits: the row it is on and its cells from the row's left edge. */
export function caretOf(
  lines: (index: number) => string,
  layout: RowLayout,
  position: Position,
  gutter: number,
  cell: number,
  lineHeight: number,
  before: boolean,
): { left: number; top: number } {
  const text = lines(position.line);
  const rows = layout.rowsOf(position.line);
  const at = rowOfColumn(rows, position.column, before);
  const row = rows.at(at) ?? rows.at(0);
  return {
    left: gutter + (row ? rowOffset(text, row, position.column) : 0) * cell,
    top: (layout.startOf(position.line) + at) * lineHeight,
  };
}

function boxes(
  selections: readonly Selection[],
  lines: (index: number) => string,
  layout: RowLayout,
  firstLine: number,
  lastLine: number,
  firstRow: number,
  lastRow: number,
  gutter: number,
  cell: number,
  lineHeight: number,
  affinity: Affinity,
  primary: number,
): { selections: Box[]; carets: Box[] } {
  const rects: Box[] = [];
  const carets: Box[] = [];
  selections.forEach((selection, index) => {
    const primaryHere = index === primary;
    const headBefore = isBefore(affinity, index);
    const { start, end } = ordered(selection);
    if (start.line !== end.line || start.column !== end.column) {
      for (
        let line = Math.max(firstLine, start.line);
        line <= Math.min(lastLine, end.line);
        line++
      ) {
        const text = lines(line);
        const rows = layout.rowsOf(line);
        const startRow = layout.startOf(line);
        const from = line === start.line ? start.column : 0;
        const to = line === end.line ? end.column : text.length;
        const headRow = rowOfColumn(rows, selection.head.column, headBefore);
        // A selection can cover a megabyte on one line: only the rows inside the window are drawn.
        const fromRow = Math.max(0, firstRow - startRow);
        const toRow = Math.min(rows.length, lastRow - startRow);
        for (let at = fromRow; at < toRow; at++) {
          const row = rows.at(at);
          if (!row) continue;
          // A selection that runs past a space kept at a break reaches the row's edge; the next
          // row starts where its own text does.
          const low = Math.max(from, row.start);
          const high = Math.min(to, row.end);
          // A row the selection only touches at its edge draws nothing, except the caret's own
          // row, where VS Code leaves a sliver.
          const caretRow = primaryHere && line === selection.head.line && at === headRow;
          if (high <= low && !caretRow) continue;
          const left = gutter + rowOffset(text, row, low) * cell;
          const right = gutter + rowOffset(text, row, high) * cell;
          rects.push({
            key: `s${index}-${line}-${at}`,
            left,
            top: (startRow + at) * lineHeight,
            width: Math.max(2, right - left),
            height: lineHeight,
          });
        }
      }
    }
    const caret = caretOf(lines, layout, selection.head, gutter, cell, lineHeight, headBefore);
    carets.push({
      key: `c${index}:${caret.left}:${caret.top}`,
      ...caret,
      width: 2,
      height: lineHeight,
    });
  });
  return { selections: rects, carets };
}

/**
 * Selections, carets and the IME's composing text, drawn as absolutely positioned layers over
 * the text, one box per visual row a selection covers. The primary caret keeps VS Code's side
 * of a hard break: at the previous row's end rather than the next row's start. They never take
 * pointer events: clicks land on the row beneath them.
 */
export function CaretLayers(props: {
  selections: readonly Selection[];
  lines: (index: number) => string;
  layout: RowLayout | undefined;
  firstLine: number;
  lastLine: number;
  /** The rows the editor draws; a selection is drawn only where the list has rows. */
  firstRow: number;
  lastRow: number;
  gutter: number;
  cell: number;
  lineHeight: number;
  /** Blink the carets (Settings › Editor). */
  blink?: boolean | undefined;
  /** Each caret's side of a hard break, so secondary carets draw on their own row. */
  affinity: Affinity;
  primary: number;
  composing: Composing | undefined;
}) {
  // Kept out of the compiler: rows are read from a wrap index whose counts change in place.
  "use no memo";
  const layout = props.layout;
  if (!layout) return null;
  const { selections, carets } = boxes(
    props.selections,
    props.lines,
    layout,
    props.firstLine,
    props.lastLine,
    props.firstRow,
    props.lastRow,
    props.gutter,
    props.cell,
    props.lineHeight,
    props.affinity,
    props.primary,
  );
  const compose = props.composing;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
      {selections.map((box) => (
        <div
          key={box.key}
          data-selection
          className="absolute bg-ring/25"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
      {carets.map((box) => (
        <div
          key={box.key}
          data-caret
          className={props.blink ? "fx-caret-blink absolute bg-ring" : "absolute bg-ring"}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
      {compose && compose.text
        ? props.selections.map((selection, index) => {
            const at = caretOf(
              props.lines,
              layout,
              selection.head,
              props.gutter,
              props.cell,
              props.lineHeight,
              isBefore(props.affinity, index),
            );
            return (
              <div
                key={`compose-${selection.head.line}-${selection.head.column}`}
                data-composing
                className="absolute whitespace-pre bg-background text-foreground shadow-[inset_0_-2px_0_var(--ring)]"
                style={{ left: at.left, top: at.top, height: props.lineHeight }}
              >
                {compose.text}
              </div>
            );
          })
        : null}
    </div>
  );
}
