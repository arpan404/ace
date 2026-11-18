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

/** The cell width and the widest visible line, kept from the rendered spans. */
export function useEditorMetrics(options: {
  scroller: RefObject<HTMLDivElement | null>;
  host: RefObject<HTMLDivElement | null>;
  doc: EditorDocument | undefined;
  lines: readonly string[];
  first: number;
  gutter: number;
  onOverflow?: ((overflow: boolean) => void) | undefined;
}): { cell: number; contentWidth: number } {
  const { scroller, host, doc, lines, first, gutter, onOverflow } = options;
  const [cell, setCell] = useState(fallbackCharWidth);
  const [content, setContent] = useState<{ doc: unknown; width: number }>({
    doc: undefined,
    width: 0,
  });

  useLayoutEffect(() => {
    const element = scroller.current;
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the cell width comes from the laid-out font, once.
    if (element) setCell(charWidthFor(getComputedStyle(element).font));
  }, [scroller]);

  // A web font or a different display density changes the cells; every cached width is stale.
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

  useEffect(() => {
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
    const width = gutter + widest;
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the widest rendered span is a DOM measurement.
    setContent((previous) => {
      const base = previous.doc === doc ? previous.width : 0;
      const next = Math.max(base, width);
      if (previous.doc === doc && previous.width === next) return previous;
      return { doc, width: next };
    });
  }, [doc, lines, cell, gutter, first, host]);

  const contentWidth = content.doc === doc ? content.width : 0;

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      onOverflow?.(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the ref object is stable; only a resize or a wider line changes this.
  }, [onOverflow, contentWidth]);

  return { cell, contentWidth };
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
