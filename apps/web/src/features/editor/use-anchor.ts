import type { RefObject } from "react";
import { lineHeight } from "./geometry.ts";
import type { RowLayout } from "./wrap-index.ts";

/*
 * The scroll anchor a re-wrap holds on to: the line at the top of the view and how far into its
 * rows the edge sits. `remember` is called just before the wrap index changes the rows above it;
 * `restore` puts the same line back after the change, before the next paint.
 *
 * This is a small store, not React state: the view is read during the render that measures the
 * new rows, where a ref may not be touched.
 */

/** Where the view is anchored: the line at the top and how many of its rows are above it. */
export interface ViewAnchor {
  line: number;
  offset: number;
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

  /** Remembers the line at the top of the view, from the rows as they stand now. */
  remember(layout: RowLayout): void {
    const top = Math.max(0, Math.floor((this.#scroller.current?.scrollTop ?? 0) / lineHeight));
    const line = layout.lineAt(top);
    this.#pending = { line, offset: top - layout.startOf(line) };
  }

  /** Puts the remembered line back at the top, from the rows as they stand after the change. */
  restore(layout: RowLayout): void {
    const saved = this.#pending;
    if (!saved) return;
    this.#pending = undefined;
    const element = this.#scroller.current;
    if (!element) return;
    // oxlint-disable-next-line react/immutability, react-compiler/immutability -- the scroller's own offset is the browser's to hold.
    element.scrollTop = (layout.startOf(saved.line) + saved.offset) * lineHeight;
    this.#onScroll({ top: element.scrollTop, left: element.scrollLeft });
  }
}
