import type { Position, Selection } from "@ace/editor";
import { useRef, type KeyboardEvent } from "react";
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
import { isBefore, noAffinity, type Affinity } from "./affinity.ts";
import { lineCommand } from "./line-keys.ts";
import { columnAtVisual } from "./geometry.ts";
import type { EditorDocumentState } from "./use-editor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { atHardBreak, rowOffset, rowOfColumn, rowText } from "./wrap.ts";

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
  /** Cmd+F opens find; Cmd+Alt+F (Cmd+H off macOS too) opens it with the replace row. */
  onFind?: ((mode: "find" | "replace") => void) | undefined;
  /** Cmd+G and Shift+Cmd+G: the next or previous match. */
  onFindAgain?: ((delta: 1 | -1) => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Ctrl+G: ask for a line to go to. */
  onGoToLine?: (() => void) | undefined;
  /** Returns true when Escape closed something (find); false collapses the carets. */
  onEscape?: (() => boolean) | undefined;
  /** Alt+Z: the person asked for wrap to toggle, as VS Code's own shortcut does. */
  onToggleWrap?: (() => void) | undefined;
  /** Each caret's side of a hard break, as the last move left it (VS Code's Before). */
  affinity: Affinity;
  /** Records every caret's side of a hard break after a move. */
  onBefore(affinity: Affinity): void;
  /** Brings a position into view, drawn on the side of a hard break the move asked for. */
  reveal(position: Position, before: boolean): void;
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
  const rowAt = (position: Position, before = false) => {
    const rows = layout?.rowsOf(position.line) ?? [];
    const at = rows.length ? rowOfColumn(rows, position.column, before) : 0;
    return { rows, at, row: rows.at(at) };
  };

  const offsetOf = (position: Position, before = false): number => {
    const { row } = rowAt(position, before);
    if (!row) return 0;
    return rowOffset(line(position.line), row, position.column);
  };

  const rowOf = (position: Position, before = false): number =>
    (layout ? layout.startOf(position.line) : position.line) + rowAt(position, before).at;

  /** Whether a caret at `position` is at the end of a row that the next row begins. */
  const beforeAt = (position: Position): boolean => {
    if (!layout) return false;
    const rows = layout.rowsOf(position.line);
    const at = rowOfColumn(rows, position.column, true);
    return atHardBreak(rows, at, position.column);
  };

  /** The position `offset` cells into a given visual row, and the caret's side of its edge. */
  const positionOnRow = (row: number, offset: number): { position: Position; before: boolean } => {
    const doc = state.doc;
    if (!doc) return { position: { line: 0, column: 0 }, before: false };
    if (!layout) {
      const fallback = Math.max(0, Math.min(lastLine(), row));
      return {
        position: { line: fallback, column: columnAtVisual(line(fallback), offset) },
        before: false,
      };
    }
    const target = layout.lineAt(row);
    const rows = layout.rowsOf(target);
    const at = Math.max(0, Math.min(row - layout.startOf(target), rows.length - 1));
    const visual = rows.at(at);
    if (!visual) return { position: { line: target, column: 0 }, before: false };
    const text = line(target);
    const column =
      visual.start + columnAtVisual(rowText(text, visual), Math.max(0, offset - visual.indent));
    // Only a goal past the row's own text lands at its end; a row's start is just its start.
    return { position: { line: target, column }, before: atHardBreak(rows, at, column) };
  };

  const commitMove = (next: readonly Selection[], affinity: Affinity = noAffinity) => {
    options.onBefore(affinity);
    state.select(next);
    const doc = state.doc;
    if (!doc) return;
    const primary = doc.primarySelection();
    options.reveal(doc.selections()[primary]?.head ?? head(), isBefore(affinity, primary));
  };

  const vertical = (delta: number, extend: boolean) => {
    const doc = state.doc;
    if (!doc) return;
    const selections = doc.selections();
    const primary = doc.primarySelection();
    const current = selections[primary]?.head ?? { line: 0, column: 0 };
    goal.current ??= offsetOf(current, isBefore(options.affinity, primary));
    const keeper = goal.current ?? 0;
    const moved: Selection[] = [];
    const affinity: boolean[] = [];
    selections.forEach((selection, index) => {
      // A secondary caret keeps its own goal; its side of a hard break is where its row ends.
      const keeperHere =
        index === primary ? keeper : offsetOf(selection.head, isBefore(options.affinity, index));
      const row = rowOf(selection.head, isBefore(options.affinity, index));
      const landed = positionOnRow(row + delta, keeperHere);
      affinity.push(landed.before);
      moved.push({ anchor: extend ? selection.anchor : landed.position, head: landed.position });
    });
    commitMove(moved, affinity);
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
  const home = (position: Position, before: boolean): number => {
    const text = line(position.line);
    const { rows, at } = rowAt(position, before);
    const row = rows.at(at);
    if (!row) return smartHome(text, position.column);
    if (at > 0) return position.column > row.start ? row.start : 0;
    return smartHome(text, position.column);
  };

  const end = (position: Position, before: boolean): number => {
    const text = line(position.line);
    const { rows, at } = rowAt(position, before);
    const row = rows.at(at);
    if (!row) return text.length;
    const rowEnd = Math.min(row.end, text.length);
    // A caret at a row's end steps to the next row's end, then to the line's.
    if (position.column < rowEnd) return rowEnd;
    const next = rows.at(at + 1);
    return next ? Math.min(next.end, text.length) : text.length;
  };

  return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const doc = state.doc;
    if (!doc) return;
    // An IME owns every key while it composes; nothing here may move the caret under it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const key = event.key;

    // Alt+Z: macOS reports the Option key's character, every other platform the letter.
    const togglesWrap = mac ? event.code === "KeyZ" : key.toLowerCase() === "z";
    if (event.altKey && !event.metaKey && !event.ctrlKey && togglesWrap) {
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
      options.onBefore(noAffinity);
      state.select([{ anchor: { line: 0, column: 0 }, head: last }]);
      options.reveal(last, false);
      return;
    }
    // Cmd+F, and Cmd+Alt+F for replace: by key position, as macOS types ƒ with Alt held.
    if (mod && (event.code === "KeyF" || key.toLowerCase() === "f")) {
      if (options.readOnly) return;
      event.preventDefault();
      options.onFind?.(event.altKey ? "replace" : "find");
      return;
    }
    // Cmd+H (Ctrl+H) opens replace too, where the system lets the key reach the page.
    if (mod && !event.altKey && !event.shiftKey && key.toLowerCase() === "h") {
      if (options.readOnly) return;
      event.preventDefault();
      options.onFind?.("replace");
      return;
    }
    // Ctrl+G is go to line on every platform; Cmd+G (F3 anywhere) is the next match on macOS.
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      key.toLowerCase() === "g"
    ) {
      if (!options.onGoToLine) return;
      event.preventDefault();
      options.onGoToLine();
      return;
    }
    if ((mac && event.metaKey && !event.altKey && key.toLowerCase() === "g") || key === "F3") {
      if (!options.onFindAgain) return;
      event.preventDefault();
      options.onFindAgain(event.shiftKey ? -1 : 1);
      return;
    }
    if (mod && key.toLowerCase() === "s") {
      if (!options.onSave) return;
      event.preventDefault();
      options.onSave();
      return;
    }
    const command = options.readOnly ? undefined : lineCommand(event, mac, path);
    if (command) {
      event.preventDefault();
      goal.current = undefined;
      if (command.kind === "edit") state.edit(command.run);
      else {
        commitMove(command.run(doc));
        return;
      }
      options.reveal(head(), isBefore(options.affinity, doc.primarySelection()));
      return;
    }
    // Shift+mod+D is ace's Changes shortcut: leave it for the page.
    if (!options.readOnly && mod && !event.shiftKey && key.toLowerCase() === "d") {
      event.preventDefault();
      if (doc.selectNextOccurrence()) {
        options.onBefore(noAffinity);
        state.select(doc.selections());
      }
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      if (options.onEscape?.()) return;
      const position = head();
      goal.current = undefined;
      options.onBefore(noAffinity);
      state.select([caret(position.line, position.column)]);
      options.reveal(position, false);
      return;
    }
    // Cmd+Alt+Up/Down (Ctrl+Alt elsewhere): another cursor on the line above or below each cursor.
    if (mod && event.altKey && !event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      event.preventDefault();
      goal.current = undefined;
      const delta = key === "ArrowUp" ? -1 : 1;
      const selections = doc.selections();
      const seen = new Set(selections.map((one) => `${one.head.line}:${one.head.column}`));
      const added: Selection[] = [];
      for (const selection of selections) {
        const target = selection.head.line + delta;
        if (target < 0 || target > lastLine()) continue;
        const column = Math.min(selection.head.column, line(target).length);
        if (seen.has(`${target}:${column}`)) continue;
        seen.add(`${target}:${column}`);
        added.push(caret(target, column));
      }
      if (added.length) commitMove([...selections, ...added]);
      return;
    }
    // Cmd+Up/Down on macOS, Ctrl+Home/End elsewhere: the document's first and last position.
    const toDocument = mac
      ? mod && !event.altKey && (key === "ArrowUp" || key === "ArrowDown")
      : mod && !event.altKey && (key === "Home" || key === "End");
    if (toDocument) {
      event.preventDefault();
      goal.current = undefined;
      const target =
        key === "ArrowUp" || key === "Home"
          ? { line: 0, column: 0 }
          : documentEnd(doc.lenLines(), line(lastLine()));
      // The cursors collapse to the primary one, as in VS Code.
      const primary = doc.selections()[doc.primarySelection()];
      commitMove([{ anchor: event.shiftKey ? (primary?.anchor ?? target) : target, head: target }]);
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
      const moved = doc.selections().map((selection, index) => {
        const before = isBefore(options.affinity, index);
        const column = key === "End" ? end(selection.head, before) : home(selection.head, before);
        const position = { line: selection.head.line, column };
        return { anchor: event.shiftKey ? selection.anchor : position, head: position };
      });
      // Home stops at a row's start; End stops at its end, which can begin the next row.
      commitMove(moved, key === "End" ? moved.map((one) => beforeAt(one.head)) : noAffinity);
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      event.preventDefault();
      const delta = Math.max(1, options.rows - 1) * (key === "PageUp" ? -1 : 1);
      vertical(delta, event.shiftKey);
    }
  };
}
