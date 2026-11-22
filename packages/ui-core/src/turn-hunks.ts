import { changeHunks, type ChangeHunk } from "./change-hunks.ts";
import type { DiffRow } from "./diff.ts";
import { linesOf, type WholeLineChange } from "./live-hunks.ts";

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

/** A hunk found by its text; `moved` when not where the turn left it. */
export type LocatedHunk = ChangeHunk & { moved: boolean };

/** The hunk at 0-based line `at` of the text now. */
const placed = (hunk: TurnHunk, at: number): ChangeHunk => {
  const start = at + 1;
  return {
    start,
    marks: hunk.added.length ? hunk.added.map((_, index) => start + index) : [Math.max(1, start)],
    added: hunk.added,
    removed: hunk.removed,
    above: hunk.above,
    below: hunk.below,
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
): LocatedHunk | undefined {
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
  return found === undefined ? undefined : { ...placed(hunk, found), moved: found !== expected };
}

/**
 * Where `hunk` is now, by the exact changes from the turn's text to the text now (when the turn
 * recorded the file's text): its own lines and the lines around it carried through them. A hunk
 * any of those lines was edited or removed in maps nowhere, whatever copies exist elsewhere.
 * Linear in the changes.
 */
export function mapHunk(
  hunk: TurnHunk,
  changes: readonly WholeLineChange[],
): ChangeHunk | undefined {
  const first = hunk.start - 1 - (hunk.above === undefined ? 0 : 1);
  const last = hunk.start - 1 + hunk.added.length - (hunk.below === undefined ? 1 : 0);
  let delta = 0;
  for (const change of changes) {
    const removes = change.end > change.start;
    // A change over the hunk's lines, or new lines inside them, ends its claim to them.
    if (
      removes
        ? change.start <= last && change.end > first
        : change.start > first && change.start <= last
    )
      return undefined;
    if (change.start > last || (!removes && change.start > first)) break;
    delta += linesOf(change.text).length - (change.end - change.start);
  }
  return placed(hunk, hunk.start - 1 + delta);
}
