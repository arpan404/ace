import type { Position, TextReplacement } from "@ace/editor";
import type { RefObject } from "react";
import { lineHeight } from "./geometry.ts";
import { rowOfColumn } from "./wrap.ts";
import type { RowLayout } from "./wrap-index.ts";

/*
 * The scroll anchor a re-wrap or an edit holds on to: the text at the top edge of the view, as
 * a UTF-16 position inside the row that starts there, plus how far into that row the edge sits.
 *
 * A text position survives what a line number does not. Toggling wrap turns one row into four
 * and four into one; typing a line above the view moves every line number below it down. Both
 * resolve the same position in the new layout, so the same text stays under the top edge.
 *
 * This is a small store, not React state: the view is read during the render that measures the
 * new rows, where a ref may not be touched.
 */

/** Where the view is anchored: the text at the top edge and its offset inside that row. */
export interface ViewAnchor {
  /** The logical line whose row starts at the top edge. */
  line: number;
  /** The UTF-16 column where that row's text starts. */
  column: number;
  /** Pixels from the row's own top edge to the view's top edge. */
  pixels: number;
}

/** Whether a position comes before another, the document's own order of lines then columns. */
function before(a: Position, b: Position): boolean {
  return a.line === b.line ? a.column < b.column : a.line < b.line;
}

/** Whether a position is at or before another. */
function notAfter(a: Position, b: Position): boolean {
  return a.line === b.line ? a.column <= b.column : a.line < b.line;
}

/**
 * The same text position after a transaction. The replaced ranges are in the document before it,
 * so one pass over them maps both line and column: a position before a range keeps the shift of
 * the ranges before it, a position inside one becomes the end of its new text (where the document
 * moves its own selections), and a position after one keeps its distance from the range's end.
 * An edit above the view therefore never pulls different text under the top edge, and an edit
 * inside the anchored line moves the column with the text the reader is looking at.
 */
export function mapAnchor(
  anchor: ViewAnchor,
  replacements: readonly TextReplacement[],
): ViewAnchor {
  let line = anchor.line;
  let column = anchor.column;
  for (const change of replacements) {
    if (before(anchor, change.start)) break;
    if (notAfter(anchor, change.end)) {
      line = change.postEnd.line;
      column = change.postEnd.column;
      continue;
    }
    line = anchor.line + (change.postEnd.line - change.end.line);
    column =
      anchor.line === change.end.line
        ? anchor.column + (change.postEnd.column - change.end.column)
        : anchor.column;
  }
  return { ...anchor, line: Math.max(0, line), column: Math.max(0, column) };
}

export class ScrollAnchor {
  readonly #scroller: RefObject<HTMLDivElement | null>;
  readonly #onScroll: (scroll: { top: number; left: number }) => void;
  #pending: ViewAnchor | undefined;

  constructor(
    scroller: RefObject<HTMLDivElement | null>,
    onScroll: (scroll: { top: number; left: number }) => void,
  ) {
    this.#scroller = scroller;
    this.#onScroll = onScroll;
  }

  /** Remembers the text at the top edge, from the rows as they stand now. */
  remember(layout: RowLayout): void {
    // A change already holds the view: the text it picked is closer than anything seen later.
    if (this.#pending) return;
    const top = Math.max(0, this.#scroller.current?.scrollTop ?? 0);
    const row = Math.floor(top / lineHeight);
    const line = layout.lineAt(row);
    const rows = layout.rowsOf(line);
    const at = Math.max(0, Math.min(row - layout.startOf(line), rows.length - 1));
    this.#pending = { line, column: rows.at(at)?.start ?? 0, pixels: top - row * lineHeight };
  }

  /** Forgets a position remembered for an operation that changed nothing. */
  discard(): void {
    this.#pending = undefined;
  }

  /** Maps the remembered position through the ranges a transaction replaced. */
  mapThrough(replacements: readonly TextReplacement[]): void {
    if (this.#pending && replacements.length)
      this.#pending = mapAnchor(this.#pending, replacements);
  }

  /** Puts the remembered text back at the top edge, from the rows as they stand after the change. */
  restore(layout: RowLayout): void {
    const saved = this.#pending;
    if (!saved) return;
    this.#pending = undefined;
    const element = this.#scroller.current;
    if (!element) return;
    const rows = layout.rowsOf(saved.line);
    // A remembered row starts at its own column: the start-of-row side belongs to the row after
    // a hard break, never to the row before it, or a slice of the idle re-wrap walks the view up.
    const at = rowOfColumn(rows, saved.column);
    // oxlint-disable-next-line react/immutability, react-compiler/immutability -- the scroller's own offset is the browser's to hold.
    element.scrollTop = Math.max(0, (layout.startOf(saved.line) + at) * lineHeight + saved.pixels);
    this.#onScroll({ top: element.scrollTop, left: element.scrollLeft });
  }
}
