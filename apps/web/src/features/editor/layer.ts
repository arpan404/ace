import type { Position, Selection, TextReplacement } from "@ace/editor";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { RowLayout } from "./wrap-index.ts";

/*
 * A layer someone else draws inside the editor's text (annotation markers, their ranges, a
 * floating affordance) and the moments it hears about: edits, whole-text replacements, keys,
 * presses on line numbers and the context menu. The editor owns none of the layer's state; it
 * hands over its geometry each render and its events as they happen.
 */

/** The editor as a layer sees it on one render. */
export interface EditorLayerView {
  /** A line's text by 0-based index, as the document holds it now. */
  line(index: number): string;
  lineCount: number;
  layout: RowLayout;
  /** The logical lines and visual rows drawn now (inclusive lines, exclusive last row). */
  firstLine: number;
  lastLine: number;
  firstRow: number;
  lastRow: number;
  gutter: number;
  cell: number;
  selections: readonly Selection[];
  primary: number;
  readOnly: boolean;
  /** Bumped on every applied edit. */
  version: number;
  /** The element the rows are positioned in, for anchoring a popup to a point in the text. */
  host: HTMLDivElement | null;
  /** Where a position is drawn, in pixels from the host's top-left. */
  pointOf(position: Position): { left: number; top: number };
  select(selections: readonly Selection[]): void;
  focus(): void;
}

export interface EditorLayer {
  /** Pixels the layer keeps at the gutter's left for its own marks, before the line numbers. */
  margin?: number;
  /** Drawn over the rows, inside the scrolled text. */
  render(view: EditorLayerView): ReactNode;
  /** The ranges an edit replaced, as the document applies it and before React draws it. */
  onEdit?(replacements: readonly TextReplacement[], view: EditorLayerView): void;
  /** The whole text was replaced from outside (the file changed on disk, an agent rewrote it). */
  onReplace?(before: string, after: string): void;
  /** A key at the editor before its own handling; true when the layer took it. */
  onKey?(event: KeyboardEvent<HTMLTextAreaElement>, view: EditorLayerView): boolean;
  /** A press on a line's number (0-based); `extend` with Shift. True when the layer took it. */
  onGutter?(line: number, extend: boolean, view: EditorLayerView): boolean;
  /** A right-click in the text; true when the layer opened its menu. */
  onContextMenu?(event: MouseEvent<HTMLDivElement>, view: EditorLayerView): boolean;
}
