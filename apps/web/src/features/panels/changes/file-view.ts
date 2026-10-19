import type { FileDiff } from "@ace/ui-core";

/**
 * How a file is shown: open or collapsed, which folds are expanded, and whether a huge diff is
 * read as text. Held by the list, so a file scrolled out of a long list and back keeps it.
 */
export interface FileView {
  open: boolean;
  expanded: ReadonlySet<number>;
  asText: boolean;
}
export const freshView: FileView = { open: true, expanded: new Set(), asText: false };

/** One diff line's height in a file block. */
export const diffRowHeight = 20;

/** Typical height of a file block before it is measured: its header and, if open, its rows. */
export const fileHeight = (file: FileDiff, view: FileView) =>
  32 + (view.open ? file.rows.length * diffRowHeight : 0);
