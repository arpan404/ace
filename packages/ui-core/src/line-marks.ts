import type { DiffRow } from "./diff.ts";

/**
 * How a line of a file's current text differs from its committed version: `added` (new),
 * `modified` (replaces removed lines), or `removed` (lines were removed just above it).
 */
export type LineMark = "added" | "modified" | "removed";

/**
 * Marks for a source view's gutter, by new-side line number, from a file's diff rows. Linear in
 * the rows. Removed lines at the end of a file mark the last line.
 */
export function lineMarks(rows: readonly DiffRow[]): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();
  let removed = 0;
  let lastNew = 0;
  for (const row of rows) {
    if (row.kind === "del") {
      removed++;
      continue;
    }
    if (row.kind === "add" && row.new !== undefined) {
      marks.set(row.new, removed > 0 ? "modified" : "added");
      if (removed > 0) removed--;
      lastNew = row.new;
      continue;
    }
    // Context or a fold after a removal: the removal sits just above the next line shown.
    const next = row.kind === "fold" ? undefined : row.new;
    if (removed > 0 && next !== undefined && !marks.has(next)) marks.set(next, "removed");
    removed = 0;
    if (next !== undefined) lastNew = next;
  }
  if (removed > 0 && lastNew > 0 && !marks.has(lastNew)) marks.set(lastNew, "removed");
  return marks;
}
