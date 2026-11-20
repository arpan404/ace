import { lineHeight as defaultLineHeight } from "./geometry.ts";
import type { RowLayout } from "./wrap-index.ts";

/*
 * The window of visual rows the editor draws around a scroll position: which rows mount, which
 * lines they come from, and the lines measured before the height is read. Kept out of the view
 * so the arithmetic can be tested against a real index without React or the DOM.
 */

/** Rows drawn past each edge of the view, so a fast scroll never shows a blank line. */
export const windowOverscan = 8;

/** Documents up to this many visual rows mount every row, as the Files viewer always has. */
export const windowMountAll = 400;

/** A layout that can be told which lines to measure first, as {@link WrapIndex} can. */
export interface MeasuredLayout extends RowLayout {
  prefer(range: { first: number; last: number }): void;
}

export interface EditorWindow {
  /** The document's visual rows. */
  rows: number;
  /** Every row is mounted: the whole document fits in one window's worth. */
  all: boolean;
  firstRow: number;
  lastRow: number;
  firstLine: number;
  lastLine: number;
}

/**
 * The rows to draw around `scrollTop`. The lines about to be shown are measured first, so the
 * row total the list takes its height from cannot change after this call.
 */
export function editorWindow(options: {
  layout: MeasuredLayout | undefined;
  lineCount: number;
  scrollTop: number;
  height: number;
  /** The height of one visual row; the editor's default when unset. */
  lineHeight?: number;
}): EditorWindow {
  const { layout, lineCount, scrollTop, height } = options;
  const lineHeight = options.lineHeight ?? defaultLineHeight;
  // Where the scroll sits from the counts as they stand: an unmeasured line counts as one row.
  const estimated = layout?.total() ?? 0;
  const guessFirst =
    estimated <= windowMountAll
      ? 0
      : Math.max(0, Math.floor(scrollTop / lineHeight) - windowOverscan);
  const guessLast =
    estimated <= windowMountAll
      ? estimated
      : Math.min(estimated, Math.ceil((scrollTop + height) / lineHeight) + windowOverscan);
  if (layout && estimated > 0) {
    layout.prefer({
      first: layout.lineAt(guessFirst) - windowOverscan,
      last: layout.lineAt(Math.max(guessFirst, guessLast - 1)) + 1 + windowOverscan,
    });
  }

  const rows = layout?.total() ?? 0;
  const all = rows <= windowMountAll;
  const firstRow = all ? 0 : Math.max(0, Math.floor(scrollTop / lineHeight) - windowOverscan);
  const lastRow = all
    ? rows
    : Math.min(rows, Math.ceil((scrollTop + height) / lineHeight) + windowOverscan);
  const firstLine = all ? 0 : (layout?.lineAt(firstRow) ?? 0);
  const lastLine = all
    ? lineCount
    : Math.min(lineCount, (layout?.lineAt(Math.max(firstRow, lastRow - 1)) ?? 0) + 1);
  return { rows, all, firstRow, lastRow, firstLine, lastLine };
}
