import type { Position, Selection } from "@ace/editor";
import { useRef, type KeyboardEvent } from "react";
import { commentToken } from "./comment.ts";
import {
  caret,
  documentEnd,
  moveAll,
  nextWord as nextWordColumn,
  previousWord,
  smartHome,
  stepBack,
  stepForward,
} from "./cursor.ts";
import { columnAtVisual } from "./geometry.ts";
import type { EditorDocumentState } from "./use-editor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { rowOffset, rowOfColumn, rowText } from "./wrap.ts";

/*
 * The editor's keybindings: Cmd on macOS, Ctrl elsewhere. Editing keys go through the document's
 * own commands; movement is computed here and applied with `setSelections`, so every cursor
 * moves together and a jump ends the typing run. Vertical movement and Home/End follow the
 * visual rows a wrapped line draws, not its logical lines.
 */

/** macOS gets Cmd and Alt; every other platform Ctrl. */
export function isMacPlatform(): boolean {
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad/.test(platform);
}

export interface EditorKeyOptions {
  state: EditorDocumentState;
  readOnly: boolean;
  path: string;
  /** Visible rows, for Page Up and Page Down. */
  rows: number;
  /** The document's visual rows, so Up and Down move a row and not a line. */
  layout: RowLayout | undefined;
  onFind?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Returns true when Escape closed something (find); false collapses the carets. */
  onEscape?: (() => boolean) | undefined;
  /** Alt+Z: the person asked for wrap to toggle, as VS Code's own shortcut does. */
  onToggleWrap?: (() => void) | undefined;
  reveal(position: Position): void;
}

export function useEditorKeys(options: EditorKeyOptions) {
  const { state, path, layout } = options;
  const mac = isMacPlatform();
  const goal = useRef<number | undefined>(undefined);

  const line = (index: number): string => state.doc?.line(index) ?? "";
  const lastLine = (): number => Math.max(0, (state.doc?.lenLines() ?? 1) - 1);
  const head = (): Position => {
    const doc = state.doc;
    if (!doc) return { line: 0, column: 0 };
    const current = doc.selections()[doc.primarySelection()];
    return current?.head ?? { line: 0, column: 0 };
  };

  /** The row a position is on and its cells from the row's left edge. */
  const rowAt = (position: Position) => {
    const rows = layout?.rowsOf(position.line) ?? [];
    const at = rows.length ? rowOfColumn(rows, position.column) : 0;
    return { rows, at, row: rows[at] };
  };

  const offsetOf = (position: Position): number => {
    const { row } = rowAt(position);
    if (!row) return 0;
    return rowOffset(line(position.line), row, position.column);
  };

  const rowOf = (position: Position): number =>
    (layout ? layout.startOf(position.line) : position.line) + rowAt(position).at;

  /** The position `offset` cells into a given visual row. */
  const positionOnRow = (row: number, offset: number): Position => {
    const doc = state.doc;
    if (!doc) return { line: 0, column: 0 };
    if (!layout) {
      const fallback = Math.max(0, Math.min(lastLine(), row));
      return { line: fallback, column: columnAtVisual(line(fallback), offset) };
    }
    const target = layout.lineAt(row);
    const rows = layout.rowsOf(target);
    const at = Math.max(0, Math.min(row - layout.startOf(target), rows.length - 1));
    const visual = rows[at];
    if (!visual) return { line: target, column: 0 };
    const text = line(target);
    return {
      line: target,
      column:
        visual.start + columnAtVisual(rowText(text, visual), Math.max(0, offset - visual.indent)),
    };
  };

  const commitMove = (next: readonly Selection[]) => {
    state.select(next);
    const doc = state.doc;
    if (doc) options.reveal(doc.selections()[doc.primarySelection()]?.head ?? head());
  };

  const vertical = (delta: number, extend: boolean) => {
    const doc = state.doc;
    if (!doc) return;
    const selections = doc.selections();
    const primary = doc.primarySelection();
    const current = selections[primary]?.head ?? { line: 0, column: 0 };
    goal.current ??= offsetOf(current);
    const keeper = goal.current ?? 0;
    const moved = selections.map((selection) => {
      const keeperHere = selection === selections[primary] ? keeper : offsetOf(selection.head);
      const position = positionOnRow(rowOf(selection.head) + delta, keeperHere);
      return { anchor: extend ? selection.anchor : position, head: position };
    });
    commitMove(moved);
  };

  const horizontal = (step: (text: string, column: number) => number, extend: boolean) => {
    const doc = state.doc;
    if (!doc) return;
    goal.current = undefined;
    commitMove(
      moveAll(
        doc.selections(),
        (position) => ({ line: position.line, column: step(line(position.line), position.column) }),
        extend,
      ),
    );
  };

  /** Home lands on the row's start before the line's; End on the row's end before the line's. */
  const home = (position: Position): number => {
    const text = line(position.line);
    const { rows, at } = rowAt(position);
    const row = rows[at];
    if (!row) return smartHome(text, position.column);
    if (at > 0) return position.column > row.start ? row.start : 0;
    return smartHome(text, position.column);
  };

  const end = (position: Position): number => {
    const text = line(position.line);
    const { rows, at } = rowAt(position);
    const row = rows[at];
    if (!row) return text.length;
    const rowEnd = Math.min(row.end, text.length);
    if (at < rows.length - 1) return position.column < rowEnd ? rowEnd : text.length;
    return text.length;
  };

  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const doc = state.doc;
    if (!doc) return;
    // An IME owns every key while it composes; nothing here may move the caret under it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const key = event.key;

    if (
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      (key.toLowerCase() === "z" || event.code === "KeyZ")
    ) {
      if (!options.onToggleWrap) return;
      event.preventDefault();
      options.onToggleWrap();
      return;
    }
    if (!options.readOnly && mod && key.toLowerCase() === "z") {
      event.preventDefault();
      state.edit((target) => (event.shiftKey ? target.redo() : target.undo()));
      return;
    }
    if (!options.readOnly && !mac && event.ctrlKey && key.toLowerCase() === "y") {
      event.preventDefault();
      state.edit((target) => target.redo());
      return;
    }
    if (mod && key.toLowerCase() === "a") {
      event.preventDefault();
      goal.current = undefined;
      const last = documentEnd(doc.lenLines(), line(lastLine()));
      state.select([{ anchor: { line: 0, column: 0 }, head: last }]);
      options.reveal(last);
      return;
    }
    if (mod && key.toLowerCase() === "f") {
      if (options.readOnly) return;
      event.preventDefault();
      options.onFind?.();
      return;
    }
    if (mod && key.toLowerCase() === "s") {
      if (!options.onSave) return;
      event.preventDefault();
      options.onSave();
      return;
    }
    if (!options.readOnly && mod && key === "/") {
      const token = commentToken(path);
      if (!token) return;
      event.preventDefault();
      state.edit((target) => target.toggleLineComment(token));
      return;
    }
    // Shift+mod+D is ace's Changes shortcut: leave it for the page.
    if (!options.readOnly && mod && !event.shiftKey && key.toLowerCase() === "d") {
      event.preventDefault();
      if (doc.selectNextOccurrence()) state.select(doc.selections());
      return;
    }
    if (!options.readOnly && key === "Tab") {
      event.preventDefault();
      state.edit((target) => (event.shiftKey ? target.outdentLines() : target.indentLines()));
      options.reveal(head());
      return;
    }
    if (!options.readOnly && event.altKey && event.shiftKey && key === "ArrowDown") {
      event.preventDefault();
      goal.current = undefined;
      state.edit((target) => target.duplicateLines());
      options.reveal(head());
      return;
    }
    if (
      !options.readOnly &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      (key === "ArrowUp" || key === "ArrowDown")
    ) {
      event.preventDefault();
      goal.current = undefined;
      state.edit((target) => (key === "ArrowUp" ? target.moveLinesUp() : target.moveLinesDown()));
      options.reveal(head());
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      if (options.onEscape?.()) return;
      const position = head();
      goal.current = undefined;
      state.select([caret(position.line, position.column)]);
      options.reveal(position);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      if (mod) return;
      event.preventDefault();
      vertical(key === "ArrowUp" ? -1 : 1, event.shiftKey);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      if (mod && mac) {
        goal.current = undefined;
        const forward = key === "ArrowRight";
        commitMove(
          moveAll(
            doc.selections(),
            (position) => ({
              line: position.line,
              column: forward ? line(position.line).length : 0,
            }),
            event.shiftKey,
          ),
        );
        return;
      }
      if (word) {
        horizontal(key === "ArrowLeft" ? previousWord : nextWordColumn, event.shiftKey);
        return;
      }
      horizontal(key === "ArrowLeft" ? stepBack : stepForward, event.shiftKey);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      goal.current = undefined;
      commitMove(
        moveAll(
          doc.selections(),
          (position) => ({
            line: position.line,
            column: key === "End" ? end(position) : home(position),
          }),
          event.shiftKey,
        ),
      );
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      event.preventDefault();
      const delta = Math.max(1, options.rows - 1) * (key === "PageUp" ? -1 : 1);
      vertical(delta, event.shiftKey);
    }
  };
}
