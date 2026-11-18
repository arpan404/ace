import type { LineEdit } from "@ace/editor";
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

/**
 * The same text position after an edit. Lines below a span move by its net change, and a
 * position inside a changed region follows the region's first new line, so an edit above the
 * view never pulls different text under the top edge.
 */
export function mapAnchor(anchor: ViewAnchor, spans: readonly LineEdit[]): ViewAnchor {
  const sorted = [...spans].toSorted((a, b) => a.firstLine - b.firstLine);
  let shift = 0;
  for (const span of sorted) {
    const inserted = Math.max(1, span.insertedLines);
    // Spans are post-edit coordinates: dropping the change of the spans before gives old lines.
    const from = span.firstLine - shift;
    if (anchor.line < from) break;
    if (anchor.line >= from + span.removedLines) {
      shift += inserted - span.removedLines;
      continue;
    }
    return { ...anchor, line: span.firstLine + Math.min(anchor.line - from, inserted - 1) };
  }
  return { ...anchor, line: Math.max(0, anchor.line + shift) };
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
    this.#pending = { line, column: rows[at]?.start ?? 0, pixels: top - row * lineHeight };
  }

  /** Maps the remembered position through an edit's spans. */
  mapThrough(spans: readonly LineEdit[]): void {
    if (this.#pending && spans.length) this.#pending = mapAnchor(this.#pending, spans);
  }

  /** Puts the remembered text back at the top edge, from the rows as they stand after the change. */
  restore(layout: RowLayout): void {
    const saved = this.#pending;
    if (!saved) return;
    this.#pending = undefined;
    const element = this.#scroller.current;
    if (!element) return;
    const rows = layout.rowsOf(saved.line);
    const at = rowOfColumn(rows, saved.column, true);
    // oxlint-disable-next-line react/immutability, react-compiler/immutability -- the scroller's own offset is the browser's to hold.
    element.scrollTop = Math.max(0, (layout.startOf(saved.line) + at) * lineHeight + saved.pixels);
    this.#onScroll({ top: element.scrollTop, left: element.scrollLeft });
  }
}
