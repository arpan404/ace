import type { Position } from "@ace/editor";
import type { MouseEvent, PointerEvent } from "react";
import { useRef } from "react";
import { wordAt } from "./cursor.ts";
import { lineHeight, tabSize } from "./geometry.ts";
import type { EditorDocumentState } from "./use-editor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { columnOnRow } from "./wrap.ts";

/*
 * Mouse and trackpad selection over the rendered rows: a click places one caret, a drag
 * extends it, Shift+click extends the last one, double-click takes a word, triple-click its line,
 * Alt+click adds a caret and Alt+drag makes a box selection through the document's own command.
 * A click lands on a visual row and comes back as a (line, column) through the wrap layout.
 */

export function usePointerSelection(options: {
  state: EditorDocumentState;
  cell: number;
  gutter: number;
  layout: RowLayout | undefined;
  element: { current: HTMLDivElement | null };
  focus(): void;
  reveal(position: Position): void;
}) {
  const { state, cell, gutter, layout } = options;
  const drag = useRef<{ anchor: Position; box: boolean; moved: boolean } | undefined>(undefined);

  const positionAt = (clientX: number, clientY: number): Position | undefined => {
    const element = options.element.current;
    const doc = state.doc;
    if (!element || !doc || !layout) return undefined;
    const rect = element.getBoundingClientRect();
    const row = Math.max(
      0,
      Math.min(layout.total() - 1, Math.floor((clientY - rect.top) / lineHeight)),
    );
    const line = layout.lineAt(row);
    const rows = layout.rowsOf(line);
    const at = Math.max(0, Math.min(row - layout.startOf(line), rows.length - 1));
    const current = rows[at];
    if (!current) return undefined;
    const x = clientX - rect.left - gutter;
    return { line, column: columnOnRow(doc.line(line), current, x, cell) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const position = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!position || !doc) return;
    event.preventDefault();
    options.focus();
    const selections = doc.selections();
    const current = selections[doc.primarySelection()];
    if (event.shiftKey && current) {
      options.state.select(
        selections.map((selection, at) =>
          at === doc.primarySelection() ? { anchor: selection.anchor, head: position } : selection,
        ),
      );
      drag.current = { anchor: current.anchor, box: false, moved: false };
    } else if (event.altKey) {
      drag.current = { anchor: position, box: true, moved: false };
      state.select([{ anchor: position, head: position }]);
    } else {
      drag.current = { anchor: position, box: false, moved: false };
      state.select([{ anchor: position, head: position }]);
    }
    options.reveal(position);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const target = drag.current;
    if (!target || event.buttons === 0) return;
    const position = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!position || !doc) return;
    target.moved = true;
    if (target.box) {
      doc.selectColumn(target.anchor, position, tabSize);
      state.select(doc.selections());
    } else {
      state.select([{ anchor: target.anchor, head: position }]);
    }
    options.reveal(position);
  };

  const onPointerUp = () => {
    const target = drag.current;
    drag.current = undefined;
    const doc = state.doc;
    if (target?.box && !target.moved && doc) {
      doc.setSelections([...doc.selections(), { anchor: target.anchor, head: target.anchor }]);
      state.select(doc.selections());
      options.reveal(target.anchor);
    }
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const position = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!position || !doc) return;
    event.preventDefault();
    const range = wordAt(doc.line(position.line), position.column);
    state.select([
      {
        anchor: { line: position.line, column: range.start },
        head: { line: position.line, column: range.end },
      },
    ]);
  };

  const onTripleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.detail !== 3) return;
    const position = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!position || !doc) return;
    event.preventDefault();
    const hasNext = position.line < doc.lenLines() - 1;
    state.select([
      {
        anchor: { line: position.line, column: 0 },
        head: hasNext
          ? { line: position.line + 1, column: 0 }
          : { line: position.line, column: doc.line(position.line).length },
      },
    ]);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onTripleClick };
}
