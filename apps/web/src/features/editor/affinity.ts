import type { Selection } from "@ace/editor";
import { atHardBreak, rowOfColumn } from "./wrap.ts";
import type { RowLayout } from "./wrap-index.ts";

/*
 * A caret's side of a hard break: the end of the row before it, or the start of the row after.
 * VS Code keeps this per caret ("Before"), and so must the editor: two carets sitting on a hard
 * break can hold opposite sides of it, and each has to be drawn and navigated from its own side.
 */

/** For each selection, whether its head sits at the end of the row before a hard break. */
export type Affinity = readonly boolean[];

/** No caret on any hard break's left side, for a fresh selection or a caret that has no side. */
export const noAffinity: Affinity = [];

/** Whether the selection at `index` holds the row before its hard break. */
export function isBefore(affinity: Affinity, index: number): boolean {
  return affinity[index] ?? false;
}

/** Every selection's side of a hard break at its head, as the rows stand now. */
export function sidesAt(
  layout: RowLayout | undefined,
  selections: readonly Selection[],
): boolean[] {
  if (!layout) return selections.map(() => false);
  return selections.map((selection) => {
    const rows = layout.rowsOf(selection.head.line);
    const at = rowOfColumn(rows, selection.head.column, true);
    return atHardBreak(rows, at, selection.head.column);
  });
}
