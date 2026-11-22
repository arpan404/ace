import { changeHunks, type ChangeHunk } from "./change-hunks.ts";
import type { DiffRow } from "./diff.ts";

/*
 * A turn's hunks for review in the editor: each hunk of the turn's diff of a file, with the
 * unchanged lines around it, found again in the file as it is now (later turns or the person
 * may have moved it). Pure; locating is bounded by how far it looks, never the file's length.
 */

/** A hunk of a turn's diff, with the unchanged lines around it in the turn's text. */
export type TurnHunk = ChangeHunk;

/** The turn's hunks of one file's diff, with the lines around each. Linear in the rows. */
export function turnHunks(rows: readonly DiffRow[]): TurnHunk[] {
  const text = new Map<number, string>();
  for (const row of rows)
    if ((row.kind === "add" || row.kind === "context") && row.new !== undefined)
      text.set(row.new, row.text);
  return changeHunks(rows).map((hunk): TurnHunk =>
    Object.assign(hunk, {
      above: text.get(hunk.start - 1),
      below: text.get(hunk.start + hunk.added.length),
    }),
  );
}

/** How far from where the turn left it a hunk is looked for. */
const reach = 2_000;

/** The hunk at 0-based line `at` of the text now. */
const placed = (hunk: TurnHunk, at: number): ChangeHunk => {
  const start = at + 1;
  // The whole hunk moves, its exact committed text (`removedText`) included: only its place changes.
  return {
    ...hunk,
    start,
    marks: hunk.added.length ? hunk.added.map((_, index) => start + index) : [Math.max(1, start)],
  };
};

/**
 * Where `hunk` is in the text now, found by its lines and the unchanged lines around it, for a
 * turn whose own text isn't known: undefined when they are gone, edited, or fit more than one
 * place (no guess between copies). `moved` says it isn't where the turn left it: its origin
 * can't be proven, so it can be shown but not reverted.
 */
export function locateHunk(
  hunk: TurnHunk,
  lineAt: (line: number) => string,
  lineCount: number,
): ChangeHunk | undefined {
  const size = hunk.added.length;
  // A pure removal is found by the lines around the gap; it needs at least one of them.
  if (size === 0 && hunk.above === undefined && hunk.below === undefined) return undefined;
  const fits = (at: number) => {
    if (at < 0 || at + size > lineCount) return false;
    for (let index = 0; index < size; index++)
      if (lineAt(at + index) !== hunk.added[index]) return false;
    if (hunk.above !== undefined && (at === 0 || lineAt(at - 1) !== hunk.above)) return false;
    if (hunk.below !== undefined && (at + size >= lineCount || lineAt(at + size) !== hunk.below))
      return false;
    return true;
  };
  const expected = hunk.start - 1;
  let found: number | undefined;
  for (let shift = 0; shift <= reach; shift++)
    for (const at of shift === 0 ? [expected] : [expected - shift, expected + shift])
      if (fits(at)) {
        if (found !== undefined) return undefined;
        found = at;
      }
  return found === undefined ? undefined : placed(hunk, found);
}
