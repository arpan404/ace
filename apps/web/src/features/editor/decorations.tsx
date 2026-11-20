// oxlint-disable react/no-array-index-key -- a decoration's key is its line and column; it has no other identity.
import type { Range } from "@ace/editor";
import { caretOf } from "./layers.tsx";
import { whitespaceMarks } from "./decorations.ts";
import type { RowLayout } from "./wrap-index.ts";
import { rowOffset, rowOfColumn } from "./wrap.ts";

/*
 * Drawn under the text: indentation guides, rulers, the bracket pair at the caret, other
 * occurrences of the caret's word, and (when asked) whitespace marks. Everything is limited to
 * the rows the editor draws; none of it takes pointer events.
 */

export interface DecorationProps {
  lines: (line: number) => string;
  layout: RowLayout | undefined;
  firstLine: number;
  lastLine: number;
  firstRow: number;
  lastRow: number;
  gutter: number;
  cell: number;
  lineHeight: number;
  /** Guide levels for `firstLine..lastLine`, one entry per line. */
  guides: readonly number[];
  indentSize: number;
  brackets: readonly Range[] | undefined;
  occurrences: readonly Range[];
  whitespace: boolean;
  /** Draw the indentation guides (Settings › Editor). */
  indentGuides: boolean;
  rulers: readonly number[];
}

export function Decorations(props: DecorationProps) {
  "use no memo";
  const { layout, lines, gutter, cell, lineHeight } = props;
  if (!layout) return null;

  /** One box per visible row a single-line range covers. */
  const boxes = (range: Range, kind: string) => {
    const line = range.start.line;
    if (line < props.firstLine || line > props.lastLine || range.end.line !== line) return [];
    const text = lines(line);
    const rows = layout.rowsOf(line);
    const at = rowOfColumn(rows, range.start.column, false);
    const row = rows.at(at);
    const index = layout.startOf(line) + at;
    if (!row || index < props.firstRow || index >= props.lastRow) return [];
    const left = gutter + rowOffset(text, row, range.start.column) * cell;
    const right = gutter + rowOffset(text, row, Math.min(range.end.column, row.end)) * cell;
    return [
      <div
        key={`${kind}-${line}-${range.start.column}`}
        data-decoration={kind}
        className={
          kind === "bracket"
            ? "absolute rounded-xs shadow-[inset_0_0_0_1px_var(--border-strong)] bg-foreground/8"
            : "absolute rounded-xs bg-foreground/10"
        }
        style={{
          left,
          top: index * lineHeight,
          width: Math.max(2, right - left),
          height: lineHeight,
        }}
      />,
    ];
  };

  const guides = [];
  const step = Math.max(1, props.indentSize) * cell;
  for (let line = props.firstLine; props.indentGuides && line <= props.lastLine; line++) {
    const level = props.guides[line - props.firstLine] ?? 0;
    if (level <= 0) continue;
    const start = layout.startOf(line);
    const count = layout.rowsOf(line).length;
    for (let at = 0; at < count; at++) {
      const index = start + at;
      if (index < props.firstRow || index >= props.lastRow) continue;
      guides.push(
        <div
          key={`guide-${line}-${at}`}
          data-indent-guide={level}
          className="absolute"
          style={{
            left: gutter,
            top: index * lineHeight,
            width: level * step,
            height: lineHeight,
            backgroundImage: `repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px ${step}px)`,
          }}
        />,
      );
    }
  }

  const marks = [];
  if (props.whitespace)
    for (let line = props.firstLine; line <= props.lastLine; line++) {
      const text = lines(line);
      const rows = layout.rowsOf(line);
      const start = layout.startOf(line);
      for (let at = 0; at < rows.length; at++) {
        const row = rows.at(at);
        const index = start + at;
        if (!row || index < props.firstRow || index >= props.lastRow) continue;
        for (const mark of whitespaceMarks(text, row.start, Math.min(row.end, text.length))) {
          const box = caretOf(
            lines,
            layout,
            { line, column: mark.column },
            gutter,
            cell,
            lineHeight,
            false,
          );
          marks.push(
            <span
              key={`ws-${line}-${mark.column}`}
              data-whitespace={mark.tab ? "tab" : "space"}
              className="absolute text-center font-mono text-subtle-foreground/60"
              style={{ left: box.left, top: index * lineHeight, width: cell, height: lineHeight }}
            >
              {mark.tab ? "→" : "·"}
            </span>,
          );
        }
      }
    }

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
      {guides}
      {props.rulers.map((column) => (
        <div
          key={`ruler-${column}`}
          data-ruler={column}
          className="absolute top-0 bottom-0 w-px bg-border"
          style={{ left: gutter + column * cell }}
        />
      ))}
      {props.occurrences.flatMap((range) => boxes(range, "occurrence"))}
      {props.brackets?.flatMap((range) => boxes(range, "bracket"))}
      {marks}
    </div>
  );
}
