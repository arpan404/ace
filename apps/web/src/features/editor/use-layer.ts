import type { Selection, TextReplacement } from "@ace/editor";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { caretOf } from "./layers.tsx";
import type { EditorLayer, EditorLayerView } from "./layer.ts";
import type { EditorDocumentState } from "./use-editor.ts";
import type { RowLayout } from "./wrap-index.ts";
import { noRows } from "./wrap.ts";

/** Nothing drawn yet: a layer's first view before the document loads. */
const noLayout: RowLayout = {
  startOf: (line) => line,
  lineAt: (row) => row,
  rowsOf: () => noRows,
  total: () => 0,
};

/**
 * The editor's side of a layer (`layer.ts`): the view it is handed this render, and the edits
 * it hears synchronously from the document, through a ref kept current after each render.
 */
export function useEditorLayer(options: {
  layer: EditorLayer | undefined;
  state: EditorDocumentState;
  layout: RowLayout | undefined;
  lineAt(line: number): string;
  firstLine: number;
  lastLine: number;
  firstRow: number;
  lastRow: number;
  gutter: number;
  cell: number;
  lineHeight: number;
  readOnly: boolean;
  host: RefObject<HTMLDivElement | null>;
  select(selections: readonly Selection[]): void;
  focus(): void;
}) {
  const { layer, state, lineAt, gutter, cell, lineHeight } = options;
  const layout = options.layout ?? noLayout;
  const view: EditorLayerView = {
    // The document itself, not the drawn window: a layer reads text as an edit lands.
    line: (index) => state.doc?.line(index) ?? "",
    lineCount: state.doc?.lenLines() ?? 0,
    layout,
    firstLine: options.firstLine,
    lastLine: options.lastLine,
    firstRow: options.firstRow,
    lastRow: options.lastRow,
    gutter,
    cell,
    lineHeight,
    selections: state.selections,
    primary: state.primary,
    readOnly: options.readOnly,
    version: state.version,
    revision: () => (state.doc ? { document: state.doc, version: state.doc.version() } : undefined),
    host: options.host.current,
    pointOf: (position) => caretOf(lineAt, layout, position, gutter, cell, lineHeight, false),
    select: options.select,
    focus: options.focus,
  };
  const latest = useRef({ layer, view });
  useLayoutEffect(() => {
    latest.current = { layer, view };
  });
  return {
    view,
    /** For the document's `onApplied`: the ranges an edit replaced. */
    edited: (replacements: readonly TextReplacement[]) => {
      if (replacements.length) latest.current.layer?.onEdit?.(replacements, latest.current.view);
    },
    /** The text was replaced whole from outside. */
    replaced: (before: string, after: string) => latest.current.layer?.onReplace?.(before, after),
  };
}
