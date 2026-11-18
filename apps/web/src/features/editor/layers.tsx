import type { Selection } from "@ace/editor";
import { ordered } from "./cursor.ts";
import { lineHeight, visualColumn } from "./geometry.ts";

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

function boxes(
  selections: readonly Selection[],
  lines: (index: number) => string,
  first: number,
  last: number,
  gutter: number,
  cell: number,
): { selections: Box[]; carets: Box[] } {
  const rects: Box[] = [];
  const carets: Box[] = [];
  let order = 0;
  for (const selection of selections) {
    const { start, end } = ordered(selection);
    if (start.line !== end.line || start.column !== end.column) {
      for (let line = Math.max(first, start.line); line <= Math.min(last, end.line); line++) {
        const text = lines(line);
        const from = line === start.line ? start.column : 0;
        const to = line === end.line ? end.column : text.length;
        const left = gutter + visualColumn(text, Math.min(from, text.length)) * cell;
        const right = gutter + visualColumn(text, Math.min(to, text.length)) * cell;
        rects.push({
          key: `s${order}-${line}`,
          left,
          top: line * lineHeight,
          width: Math.max(2, right - left),
          height: lineHeight,
        });
      }
    }
    const headText = lines(selection.head.line);
    carets.push({
      key: `c${order}`,
      left:
        gutter + visualColumn(headText, Math.min(selection.head.column, headText.length)) * cell,
      top: selection.head.line * lineHeight,
      width: 2,
      height: lineHeight,
    });
    order++;
  }
  return { selections: rects, carets };
}

/**
 * Selections, carets and the IME's composing text, drawn as absolutely positioned layers over
 * the text. They never take pointer events: clicks land on the line beneath them.
 */
export function CaretLayers(props: {
  selections: readonly Selection[];
  lines: (index: number) => string;
  first: number;
  last: number;
  gutter: number;
  cell: number;
  composing: Composing | undefined;
}) {
  const { selections, carets } = boxes(
    props.selections,
    props.lines,
    props.first,
    props.last,
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
        ? props.selections.map((selection) => (
            <div
              key={`compose-${selection.head.line}-${selection.head.column}`}
              data-composing
              className="absolute whitespace-pre bg-background text-foreground shadow-[inset_0_-2px_0_var(--ring)]"
              style={{
                left:
                  props.gutter +
                  visualColumn(
                    props.lines(selection.head.line),
                    Math.min(selection.head.column, props.lines(selection.head.line).length),
                  ) *
                    props.cell,
                top: selection.head.line * lineHeight,
                height: lineHeight,
              }}
            >
              {compose.text}
            </div>
          ))
        : null}
    </div>
  );
}
