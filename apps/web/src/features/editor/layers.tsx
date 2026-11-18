import type { Position, Selection } from "@ace/editor";
import { ordered } from "./cursor.ts";
import { lineHeight } from "./geometry.ts";
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

interface Caret {
  left: number;
  top: number;
}

/** Where a position sits: the row it is on and its cells from the row's left edge. */
function caretOf(
  lines: (index: number) => string,
  layout: RowLayout,
  position: Position,
  gutter: number,
  cell: number,
): Caret {
  const text = lines(position.line);
  const rows = layout.rowsOf(position.line);
  const at = rowOfColumn(rows, position.column);
  const row = rows[at] ?? rows[0];
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
  gutter: number,
  cell: number,
): { selections: Box[]; carets: Box[] } {
  const rects: Box[] = [];
  const carets: Box[] = [];
  let order = 0;
  for (const selection of selections) {
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
        rows.forEach((row, at) => {
          const low = Math.max(from, row.start);
          const high = Math.min(to, row.end);
          if (high < low) return;
          const left = gutter + rowOffset(text, row, low) * cell;
          const right = gutter + rowOffset(text, row, high) * cell;
          rects.push({
            key: `s${order}-${line}-${at}`,
            left,
            top: (startRow + at) * lineHeight,
            width: Math.max(2, right - left),
            height: lineHeight,
          });
        });
      }
    }
    const caret = caretOf(lines, layout, selection.head, gutter, cell);
    carets.push({ key: `c${order}`, ...caret, width: 2, height: lineHeight });
    order++;
  }
  return { selections: rects, carets };
}

/**
 * Selections, carets and the IME's composing text, drawn as absolutely positioned layers over
 * the text, one box per visual row a selection covers. They never take pointer events: clicks
 * land on the row beneath them.
 */
export function CaretLayers(props: {
  selections: readonly Selection[];
  lines: (index: number) => string;
  layout: RowLayout | undefined;
  firstLine: number;
  lastLine: number;
  gutter: number;
  cell: number;
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
    props.gutter,
    props.cell,
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
          className="absolute bg-ring"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
      {compose && compose.text
        ? props.selections.map((selection) => {
            const at = caretOf(props.lines, layout, selection.head, props.gutter, props.cell);
            return (
              <div
                key={`compose-${selection.head.line}-${selection.head.column}`}
                data-composing
                className="absolute whitespace-pre bg-background text-foreground shadow-[inset_0_-2px_0_var(--ring)]"
                style={{ left: at.left, top: at.top, height: lineHeight }}
              >
                {compose.text}
              </div>
            );
          })
        : null}
    </div>
  );
}
