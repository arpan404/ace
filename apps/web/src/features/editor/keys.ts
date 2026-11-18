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
import { columnAtVisual, visualColumn } from "./geometry.ts";
import type { EditorDocumentState } from "./use-editor.ts";

/*
 * The editor's keybindings: Cmd on macOS, Ctrl elsewhere. Editing keys go through the document's
 * own commands; movement is computed here and applied with `setSelections`, so every cursor
 * moves together and a jump ends the typing run.
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
  onFind?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Returns true when Escape closed something (find); false collapses the carets. */
  onEscape?: (() => boolean) | undefined;
  reveal(position: Position): void;
}

export function useEditorKeys(options: EditorKeyOptions) {
  const { state, path } = options;
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
    goal.current ??= visualColumn(line(current.line), current.column);
    const keeper = goal.current ?? 0;
    const moved = selections.map((selection) => {
      const lineIndex = Math.max(0, Math.min(lastLine(), selection.head.line + delta));
      const visual =
        selection === selections[primary]
          ? keeper
          : visualColumn(line(selection.head.line), selection.head.column);
      const position = { line: lineIndex, column: columnAtVisual(line(lineIndex), visual) };
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

  const toColumn = (columnAt: (text: string, column: number) => number, extend: boolean) => {
    const doc = state.doc;
    if (!doc) return;
    goal.current = undefined;
    commitMove(
      moveAll(
        doc.selections(),
        (position) => ({
          line: position.line,
          column: columnAt(line(position.line), position.column),
        }),
        extend,
      ),
    );
  };

  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const doc = state.doc;
    if (!doc) return;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const key = event.key;

    if (mod && key.toLowerCase() === "z") {
      event.preventDefault();
      state.edit((target) => (event.shiftKey ? target.redo() : target.undo()));
      return;
    }
    if (!mac && event.ctrlKey && key.toLowerCase() === "y") {
      event.preventDefault();
      state.edit((target) => target.redo());
      return;
    }
    if (mod && key.toLowerCase() === "a") {
      event.preventDefault();
      goal.current = undefined;
      const end = documentEnd(doc.lenLines(), line(lastLine()));
      state.select([{ anchor: { line: 0, column: 0 }, head: end }]);
      options.reveal(end);
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
    if (!options.readOnly && mod && key.toLowerCase() === "d") {
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
    if (!options.readOnly && event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
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
      toColumn(key === "End" ? (text) => text.length : smartHome, event.shiftKey);
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      event.preventDefault();
      const delta = Math.max(1, options.rows - 1) * (key === "PageUp" ? -1 : 1);
      vertical(delta, event.shiftKey);
    }
  };
}
