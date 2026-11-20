import type { EditorDocument, Position, Selection } from "@ace/editor";
import { ordered } from "./cursor.ts";
import { columnAtVisual, tabSize, visualColumn } from "./geometry.ts";

/*
 * Multi-cursor helpers the keys use: carets at the end of every selected line (Shift+Alt+I) and
 * a box selection grown from the keyboard (Shift+Alt+Cmd+arrows), kept in visual columns so a
 * box keeps its edges across short lines and tabs.
 */

/** Shift+Alt+I: one caret at the end of every line each selection covers. */
export function cursorsAtLineEnds(doc: EditorDocument): Selection[] {
  const out: Selection[] = [];
  for (const selection of doc.selections()) {
    const { start, end } = ordered(selection);
    // A selection that ends at a line's start does not take that line.
    const last = end.line > start.line && end.column === 0 ? end.line - 1 : end.line;
    for (let line = start.line; line <= last; line++) {
      const column = doc.line(line).length;
      out.push({ anchor: { line, column }, head: { line, column } });
    }
  }
  return out;
}

/** A box selection's corners, as lines and visual columns. */
export interface Box {
  anchor: { line: number; visual: number };
  head: { line: number; visual: number };
}

/** The box the primary selection starts: its anchor and head, in visual columns. */
export function boxFrom(doc: EditorDocument, size = tabSize): Box {
  const selection = doc.selections()[doc.primarySelection()] ?? {
    anchor: { line: 0, column: 0 },
    head: { line: 0, column: 0 },
  };
  const corner = (position: Position) => ({
    line: position.line,
    visual: visualColumn(doc.line(position.line), position.column, size),
  });
  return { anchor: corner(selection.anchor), head: corner(selection.head) };
}

/** The box after one arrow key moves its head, clamped to the document. */
export function moveBox(box: Box, key: string, lineCount: number): Box {
  const { line, visual } = box.head;
  const head =
    key === "ArrowUp"
      ? { line: Math.max(0, line - 1), visual }
      : key === "ArrowDown"
        ? { line: Math.min(lineCount - 1, line + 1), visual }
        : key === "ArrowLeft"
          ? { line, visual: Math.max(0, visual - 1) }
          : { line, visual: visual + 1 };
  return { anchor: box.anchor, head };
}

/** The head's column on its own line, for revealing the box's moving corner. */
export function boxHead(doc: EditorDocument, box: Box, size = tabSize): Position {
  const text = doc.line(box.head.line);
  return { line: box.head.line, column: columnAtVisual(text, box.head.visual, size) };
}
