import { changeHunks, type ChangeHunk } from "./change-hunks.ts";
import type { DiffRow } from "./diff.ts";

/*
 * A turn's hunks for review in the editor: each hunk of the turn's diff of a file, with the
 * unchanged lines around it, found again in the file as it is now (later turns or the person
 * may have moved it). Pure; locating is bounded by how far it looks, never the file's length.
 */

export interface TurnHunk extends ChangeHunk {
  /** The line just above the hunk in the turn's text, when the diff shows it. */
  above?: string | undefined;
  /** The line just below it. */
  below?: string | undefined;
}

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

/**
 * Where `hunk` is in the text now: its lines (and the unchanged lines around them) at the place
 * nearest to where the turn left them, as a hunk at that place; undefined when they are gone or
 * were edited since.
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
  for (let shift = 0; shift <= reach; shift++)
    for (const at of shift === 0 ? [expected] : [expected - shift, expected + shift])
      if (fits(at)) {
        const start = at + 1;
        return {
          start,
          marks: size ? hunk.added.map((_, index) => start + index) : [Math.max(1, start)],
          added: hunk.added,
          removed: hunk.removed,
        };
      }
  return undefined;
}
