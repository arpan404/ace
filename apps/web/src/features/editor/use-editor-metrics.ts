import type { EditorDocument, Selection } from "@ace/editor";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import {
  charWidthFor,
  clearMeasurements,
  fallbackCharWidth,
  isPlain,
  lineWidth,
  measureElement,
} from "./geometry.ts";

/* Measurement and screen-reader mirroring: everything that needs the laid-out DOM. */

/** The text column's right breathing room, so a line's last glyph is never clipped. */
const rightPadding = 24;

/** The monospace cell of the editor's font, remeasured when a web font or the density changes. */
export function useCellWidth(
  scroller: RefObject<HTMLDivElement | null>,
  /** The font the editor asks for (family and size): a new one is measured again. */
  font: string,
): number {
  const [cell, setCell] = useState(fallbackCharWidth);

  useLayoutEffect(() => {
    const element = scroller.current;
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the cell width comes from the laid-out font, once per font.
    if (element) setCell(charWidthFor(getComputedStyle(element).font));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new font is read from the laid-out element, not from the key.
  }, [scroller, font]);

  useEffect(() => {
    const measure = () => {
      clearMeasurements();
      const element = scroller.current;
      if (element) setCell(charWidthFor(getComputedStyle(element).font));
    };
    document.fonts?.addEventListener("loadingdone", measure);
    if (typeof matchMedia !== "function")
      return () => document.fonts?.removeEventListener("loadingdone", measure);
    let density: MediaQueryList | undefined;
    const changed = () => {
      measure();
      watch();
    };
    const watch = () => {
      density?.removeEventListener("change", changed);
      density = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      density.addEventListener("change", changed);
    };
    watch();
    return () => {
      document.fonts?.removeEventListener("loadingdone", measure);
      density?.removeEventListener("change", changed);
    };
  }, [scroller]);

  return cell;
}

/**
 * The width the text column scrolls to: the widest visible line, never narrower than before, so
 * the scroller does not jump as the view moves through the file. Wrapped lines have no width of
 * their own, and a line running past the right edge is reported through `onOverflow`.
 */
export function useEditorWidth(options: {
  scroller: RefObject<HTMLDivElement | null>;
  host: RefObject<HTMLDivElement | null>;
  doc: EditorDocument | undefined;
  lines: readonly string[];
  first: number;
  cell: number;
  gutter: number;
  /** Lines wrap at the editor's width, so nothing is ever wider than it. */
  wrap: boolean;
  onOverflow?: ((overflow: boolean) => void) | undefined;
}): { contentWidth: number } {
  const { scroller, host, doc, lines, first, cell, gutter, wrap, onOverflow } = options;
  const [content, setContent] = useState<{ doc: unknown; width: number }>({
    doc: undefined,
    width: 0,
  });

  useEffect(() => {
    if (wrap) return;
    const element = host.current;
    if (!element) return;
    let widest = 0;
    lines.forEach((text, offset) => {
      const rendered = element.querySelector<HTMLElement>(`[data-line-text="${first + offset}"]`);
      const width = isPlain(text)
        ? lineWidth(text, cell)
        : measureElement(rendered ?? element) || lineWidth(text, cell);
      widest = Math.max(widest, width);
    });
    const width = gutter + widest + rightPadding;
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the widest rendered span is a DOM measurement.
    setContent((previous) => {
      const base = previous.doc === doc ? previous.width : 0;
      const next = Math.max(base, width);
      if (previous.doc === doc && previous.width === next) return previous;
      return { doc, width: next };
    });
  }, [doc, lines, cell, gutter, first, host, wrap]);

  const contentWidth = wrap ? 0 : content.doc === doc ? content.width : 0;

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      onOverflow?.(!wrap && element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the ref object is stable; only a resize, a wider line or wrap changes this.
  }, [onOverflow, contentWidth, wrap]);

  return { contentWidth };
}

/**
 * The hidden textarea carries the line the caret is on, so a screen reader reads the text it is
 * moving through instead of an empty box. The value is refreshed between keystrokes only.
 */
export function useMirrorLine(options: {
  field: RefObject<HTMLTextAreaElement | null>;
  lineAt: (line: number) => string;
  caretLine: number;
  caretColumn: number;
  selections: readonly Selection[];
  primary: number;
  composing: boolean;
  version: number;
}): () => void {
  const { field, lineAt, caretLine, caretColumn, selections, primary, composing, version } =
    options;
  const mirror = () => {
    const element = field.current;
    if (!element || document.activeElement !== element || composing) return;
    const text = lineAt(caretLine);
    // oxlint-disable-next-line react/immutability, react-compiler/immutability -- the hidden box is the screen reader's view of the line.
    if (element.value !== text) element.value = text;
    const selection = selections[primary];
    const anchor = selection
      ? selection.anchor.line === caretLine
        ? selection.anchor.column
        : selection.anchor.line < caretLine
          ? 0
          : text.length
      : caretColumn;
    const from = Math.max(0, Math.min(anchor, caretColumn, text.length));
    const to = Math.max(0, Math.min(Math.max(anchor, caretColumn), text.length));
    element.setSelectionRange(from, to);
  };
  useEffect(() => {
    mirror();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- every caret move re-mirrors the line.
  }, [version, lineAt, caretLine, caretColumn, selections, primary, composing]);
  // oxlint-disable-next-line react-compiler/immutability -- onFocus calls it; it writes only the hidden box.
  return mirror;
}
