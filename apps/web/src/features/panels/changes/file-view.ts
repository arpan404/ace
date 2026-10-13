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
