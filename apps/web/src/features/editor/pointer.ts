import type { Position, Selection } from "@ace/editor";
import type { MouseEvent, PointerEvent } from "react";
import { useRef } from "react";
import { carrySides, noAffinity, type Affinity } from "./affinity.ts";
import { wordAt } from "./cursor.ts";
import { lineHeight, tabSize } from "./geometry.ts";
import type { EditorDocumentState } from "./use-editor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { atHardBreak, columnOnRow } from "./wrap.ts";

/*
 * Mouse and trackpad selection over the rendered rows: a click places one caret, a drag
 * extends it, Shift+click extends the last one, double-click takes a word, triple-click its line,
 * Alt+click adds a caret, Alt+drag adds a selection, and Shift+Alt+drag (or Shift+Alt+click)
 * makes a box selection from the caret through the document's own command.
 * A click lands on a visual row and comes back as a (line, column) through the wrap layout.
 */

export function usePointerSelection(options: {
  state: EditorDocumentState;
  cell: number;
  gutter: number;
  layout: RowLayout | undefined;
  element: { current: HTMLDivElement | null };
  focus(): void;
  reveal(position: Position, before: boolean): void;
  /** Each caret's side of a hard break as the last move left it. */
  affinity: Affinity;
  /** Records every caret's side of a hard break after the click moved them. */
  onBefore(affinity: Affinity): void;
  /** A click in the gutter on a line; true when it was taken (a fold opened or closed). */
  onGutter?: ((line: number) => boolean) | undefined;
}) {
  const { state, cell, gutter, layout } = options;
  const drag = useRef<
    | {
        anchor: Position;
        before: boolean;
        mode: "replace" | "box" | "add";
        moved: boolean;
        /** The cursors an Alt+drag adds its selection to. */
        kept: readonly Selection[];
      }
    | undefined
  >(undefined);

  const positionAt = (
    clientX: number,
    clientY: number,
  ): { position: Position; before: boolean } | undefined => {
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
    const current = rows.at(at);
    if (!current) return undefined;
    const x = clientX - rect.left - gutter;
    const column = columnOnRow(doc.line(line), current, x, cell);
    // A click past a row's edge stays on that row, drawn at its end.
    return { position: { line, column }, before: atHardBreak(rows, at, column) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!target || !doc) return;
    const position = target.position;
    event.preventDefault();
    options.focus();
    // The gutter sticks to the scroller's left edge, wherever the text has scrolled to.
    const edge = options.element.current?.parentElement?.getBoundingClientRect().left ?? 0;
    if (event.clientX - edge < gutter && options.onGutter?.(position.line)) return;
    const selections = doc.selections();
    const current = selections[doc.primarySelection()];
    if (event.shiftKey && event.altKey && current) {
      // A box from the caret to the click, as VS Code's column selection.
      const anchor = current.head;
      drag.current = { anchor, before: target.before, mode: "box", moved: true, kept: [] };
      state.selectBy((one) => one.selectColumn(anchor, position, tabSize));
    } else if (event.shiftKey && current) {
      options.state.select(
        selections.map((selection, at) =>
          at === doc.primarySelection() ? { anchor: selection.anchor, head: position } : selection,
        ),
      );
      drag.current = {
        anchor: current.anchor,
        before: target.before,
        mode: "replace",
        moved: false,
        kept: [],
      };
    } else if (event.altKey) {
      drag.current = {
        anchor: position,
        before: target.before,
        mode: "add",
        moved: false,
        kept: selections,
      };
    } else {
      drag.current = {
        anchor: position,
        before: target.before,
        mode: "replace",
        moved: false,
        kept: [],
      };
      state.select([{ anchor: position, head: position }]);
    }
    // A Shift+click must leave every caret it did not move on the side it already had.
    options.onBefore(
      carrySides(layout, selections, options.affinity, doc.selections(), {
        position,
        before: target.before,
      }),
    );
    options.reveal(position, target.before);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const target = drag.current;
    if (!target || event.buttons === 0) return;
    const landed = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!landed || !doc) return;
    target.moved = true;
    const previous = doc.selections();
    if (target.mode === "box") {
      state.selectBy((current) => current.selectColumn(target.anchor, landed.position, tabSize));
    } else if (target.mode === "add") {
      state.select([...target.kept, { anchor: target.anchor, head: landed.position }]);
    } else {
      state.select([{ anchor: target.anchor, head: landed.position }]);
    }
    options.onBefore(
      carrySides(layout, previous, options.affinity, doc.selections(), {
        position: landed.position,
        before: landed.before,
      }),
    );
    options.reveal(landed.position, landed.before);
  };

  const onPointerUp = () => {
    const target = drag.current;
    drag.current = undefined;
    const doc = state.doc;
    if (target?.mode === "add" && !target.moved && doc) {
      const previous = doc.selections();
      state.select([...previous, { anchor: target.anchor, head: target.anchor }]);
      // Alt+click adds a caret: every other caret was not touched by it.
      options.onBefore(
        carrySides(layout, previous, options.affinity, doc.selections(), {
          position: target.anchor,
          before: target.before,
        }),
      );
      options.reveal(target.anchor, target.before);
    }
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const landed = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!landed || !doc) return;
    const position = landed.position;
    event.preventDefault();
    options.onBefore(noAffinity);
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
    const landed = positionAt(event.clientX, event.clientY);
    const doc = state.doc;
    if (!landed || !doc) return;
    const position = landed.position;
    event.preventDefault();
    options.onBefore(noAffinity);
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
