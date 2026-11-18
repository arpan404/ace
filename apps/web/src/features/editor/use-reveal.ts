import type { EditorDocument, Position } from "@ace/editor";
import { useCallback, type RefObject } from "react";
import { lineHeight, visualColumn } from "./geometry.ts";
import type { RowLayout } from "./wrap-index.ts";
import { rowOfColumn, rowOffset } from "./wrap.ts";

/*
 * Bringing a caret into view: where a position sits in the text column, and the scroll that puts
 * it there. Wrapped lines have no right edge to reach, so only the vertical scroll happens then.
 */

/** The caret's box in the text column, in pixels from the content's top-left corner. */
export function caretBox(
  doc: EditorDocument | undefined,
  layout: RowLayout | undefined,
  position: Position,
  gutter: number,
  cell: number,
): { left: number; top: number } {
  const text = doc?.line(position.line) ?? "";
  if (!layout)
    return {
      left: gutter + visualColumn(text, position.column) * cell,
      top: position.line * lineHeight,
    };
  const rows = layout.rowsOf(position.line);
  const at = rowOfColumn(rows, position.column);
  const row = rows[at] ?? rows[0];
  return {
    left: gutter + (row ? rowOffset(text, row, position.column) : 0) * cell,
    top: (layout.startOf(position.line) + at) * lineHeight,
  };
}

export function useReveal(options: {
  doc: EditorDocument | undefined;
  layout: RowLayout | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  gutter: number;
  cell: number;
  wrap: boolean;
  viewport: { width: number; height: number };
  onScroll(scroll: { top: number; left: number }): void;
}): {
  caretBox(position: Position): { left: number; top: number };
  reveal(position: Position): void;
} {
  const { doc, layout, scroller, gutter, cell, wrap, viewport, onScroll } = options;
  const box = useCallback(
    (position: Position) => caretBox(doc, layout, position, gutter, cell),
    [doc, layout, gutter, cell],
  );
  const reveal = useCallback(
    (position: Position) => {
      const element = scroller.current;
      if (!element) return;
      const caret = box(position);
      const heightNow = element.clientHeight || viewport.height;
      let top = element.scrollTop;
      if (caret.top < top) top = caret.top;
      else if (caret.top + lineHeight > top + heightNow) top = caret.top + lineHeight - heightNow;
      // Wrapped lines have no right edge to reach: no horizontal scroll, whatever the caret's x.
      let left = element.scrollLeft;
      if (!wrap) {
        const rightPadding = 24;
        const width = element.clientWidth || viewport.width;
        if (caret.left < left + gutter) left = Math.max(0, caret.left - gutter);
        else if (caret.left > left + width - rightPadding)
          left = caret.left - width + rightPadding * 2;
      }
      element.scrollTo({ top, left });
      // Read back what the browser allowed: a scroll past either end clamps.
      onScroll({ top: element.scrollTop, left: element.scrollLeft });
    },
    [box, scroller, gutter, wrap, viewport.height, viewport.width, onScroll],
  );
  return { caretBox: box, reveal };
}
