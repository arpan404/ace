import { linesOf, type WholeLineChange } from "@ace/ui-core";

/*
 * The merge bar's words (docs/editor/workbench.md 46): what the other side changed and where,
 * what the person was editing, and whether the two meet. "Claude Code changed lines 2–3 while
 * you were editing line 5. No overlap." Pure; linear in the changes.
 */

/** 1-based inclusive lines one side's change covers in its own text. */
interface Lines {
  from: number;
  to: number;
}

/** Each change's lines in the text it produced (a removal names the line after the gap). */
function linesAfter(changes: readonly WholeLineChange[]): Lines[] {
  let delta = 0;
  return changes.map((change) => {
    const start = change.start + delta;
    const written = linesOf(change.text).length;
    delta += written - (change.end - change.start);
    return { from: start + 1, to: start + Math.max(1, written) };
  });
}

const one = (lines: Lines) => (lines.from === lines.to ? `${lines.from}` : `${lines.from}–${lines.to}`);

/** "line 5", "lines 2–3", "lines 2–3 and 9", "lines 2–3, 9 and 2 more places". */
export function linesWords(lines: readonly Lines[]): string {
  const [first, second] = lines;
  if (!first) return "";
  if (!second) return first.from === first.to ? `line ${first.from}` : `lines ${one(first)}`;
  if (lines.length === 2) return `lines ${one(first)} and ${one(second)}`;
  const more = lines.length - 2;
  return `lines ${one(first)}, ${one(second)} and ${more} more ${more === 1 ? "place" : "places"}`;
}

/** Whether two changes of one base meet: the same lines, or lines that touch. */
function meet(a: WholeLineChange, b: WholeLineChange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** How many of `mine` meet any of `theirs`: the blocks Merge will ask about. */
export function overlaps(
  mine: readonly WholeLineChange[],
  theirs: readonly WholeLineChange[],
): number {
  return mine.filter((change) => theirs.some((other) => meet(change, other))).length;
}

export function clashWords(input: {
  /** Who changed the disk ("Claude Code"); undefined when nobody can be named. */
  who: string | undefined;
  /** `lineChanges(base, theirs)` and `lineChanges(base, mine)`. */
  theirs: readonly WholeLineChange[];
  mine: readonly WholeLineChange[];
}): string {
  const where = linesWords(linesAfter(input.theirs));
  const changed = input.who
    ? where
      ? `${input.who} changed ${where}`
      : `${input.who} changed this file`
    : where
      ? `This file changed on disk at ${where}`
      : "This file changed on disk";
  const editing = linesWords(linesAfter(input.mine));
  const meeting = overlaps(input.mine, input.theirs);
  const ending =
    meeting === 0
      ? "No overlap."
      : meeting === 1
        ? "One place overlaps."
        : `${meeting} places overlap.`;
  return editing ? `${changed} while you were editing ${editing}. ${ending}` : `${changed}.`;
}

/** The conflict bar's words, once Merge found blocks both sides changed differently. */
export function conflictWords(who: string | undefined, blocks: number, answered: number): string {
  const both = who ? `${who} and you` : "The disk and you";
  const places = blocks === 1 ? "1 place" : `${blocks} places`;
  const left = blocks - answered;
  return left === 0
    ? `${both} both changed ${places}. Merging…`
    : `${both} both changed ${places}. Choose a side for ${left === blocks ? (blocks === 1 ? "it" : "each") : `the ${left} left`} to finish the merge.`;
}
