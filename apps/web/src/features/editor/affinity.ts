import type { Position, Selection } from "@ace/editor";
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

/** Whether two selections cover exactly the same text. */
function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.anchor.line === b.anchor.line &&
    a.anchor.column === b.anchor.column &&
    a.head.line === b.head.line &&
    a.head.column === b.head.column
  );
}

/**
 * Every caret's side after a click replaced or moved some of them. A caret the click left alone
 * keeps the side it had; the caret the click moved to `moved` takes the side the hit test found.
 * The document sorts and merges the selections it is given, so a side is matched to its selection
 * by the text it covers, never by the index it happened to have before.
 */
export function carrySides(
  layout: RowLayout | undefined,
  before: readonly Selection[],
  sides: Affinity,
  after: readonly Selection[],
  moved: { position: Position; before: boolean },
): boolean[] {
  const measured = sidesAt(layout, after);
  const used = new Set<number>();
  const kept = after.map((selection) => {
    const at = before.findIndex(
      (previous, index) => !used.has(index) && sameSelection(previous, selection),
    );
    if (at < 0) return undefined;
    used.add(at);
    return isBefore(sides, at);
  });
  // The moved caret is the one at the hit position that no old selection already described; when
  // the click lands exactly on an existing caret, its head still names the same one.
  let target = -1;
  let fallback = -1;
  for (let index = 0; index < after.length; index++) {
    const head = after[index]?.head;
    if (!head || head.line !== moved.position.line || head.column !== moved.position.column)
      continue;
    fallback = index;
    if (kept[index] === undefined) {
      target = index;
      break;
    }
  }
  if (target < 0) target = fallback;
  return measured.map((side, index) => (index === target ? moved.before : (kept[index] ?? side)));
}
