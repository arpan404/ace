import type { EditorDocument, Position } from "@ace/editor";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { lineHeight, visualColumn } from "./geometry.ts";
import type { RowLayout } from "./wrap-index.ts";
import { rowOfColumn, rowOffset } from "./wrap.ts";

/*
 * Bringing a caret into view: where a position sits in the text column, and the scroll that puts
 * it there. Wrapped lines have no right edge to reach, so only the vertical scroll happens then.
 *
 * A position on a hard break has two boxes, one on each row; the caller says which one it asked
 * for, because the caret's stored side is one render behind the move that just happened.
 */

/** The caret's box in the text column, in pixels from the content's top-left corner. */
export function caretBox(
  doc: EditorDocument | undefined,
  layout: RowLayout | undefined,
  position: Position,
  gutter: number,
  cell: number,
  before = false,
): { left: number; top: number } {
  const text = doc?.line(position.line) ?? "";
  if (!layout)
    return {
      left: gutter + visualColumn(text, position.column) * cell,
      top: position.line * lineHeight,
    };
  const rows = layout.rowsOf(position.line);
  const at = rowOfColumn(rows, position.column, before);
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
  caretBox(position: Position, side: boolean): { left: number; top: number };
  reveal(position: Position, side: boolean): void;
} {
  const { doc, layout, scroller, gutter, cell, wrap, viewport, onScroll } = options;
  const box = useCallback(
    (position: Position, side: boolean): { left: number; top: number } =>
      caretBox(doc, layout, position, gutter, cell, side),
    [doc, layout, gutter, cell],
  );
  // Every caller says which side of a hard break it wants, so the callback does not change when
  // a caret's stored side does: a jump that already ran must not run again for a move.
  const reveal = useCallback(
    (position: Position, side: boolean) => {
      const element = scroller.current;
      if (!element) return;
      const caret = box(position, side);
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

/**
 * The line an explicit jump announces to a screen reader, once per jump: a go-to-line, a find
 * hit. It rides on `aria-live` so the caret's move is spoken without reading the whole file.
 */
export function useAnnouncement(): {
  announcement: { text: string; seq: number } | undefined;
  announce(position: Position): void;
} {
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>();
  const announce = (position: Position) =>
    setAnnouncement((previous) => ({
      text: `Line ${position.line + 1}, column ${position.column + 1}`,
      seq: (previous?.seq ?? 0) + 1,
    }));
  return { announcement, announce };
}

/**
 * Brings the editor to the line its tab asked for, and to the current find hit. A jump runs once
 * per request: the same line or hit arriving again in a render, or a scroll callback changing
 * because a caret's side did, never re-runs the scroll the reader has already moved away from.
 */
export function useRevealJump(options: {
  line: number | undefined;
  hit: { line: number; column: number } | undefined;
  reveal(position: Position, side: boolean): void;
  announce(position: Position): void;
}): void {
  const { line, hit, reveal, announce } = options;
  const jumpedTo = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!line || line <= 0 || jumpedTo.current === line) return;
    jumpedTo.current = line;
    const position = { line: line - 1, column: 0 };
    reveal(position, false);
    announce(position);
  }, [line, reveal, announce]);

  const hitLine = hit?.line;
  const hitColumn = hit?.column;
  const jumpedHit = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (hitLine === undefined || hitColumn === undefined) return;
    const request = `${hitLine}:${hitColumn}`;
    if (jumpedHit.current === request) return;
    jumpedHit.current = request;
    const position = { line: hitLine, column: hitColumn };
    reveal(position, false);
    announce(position);
  }, [hitLine, hitColumn, reveal, announce]);
}
