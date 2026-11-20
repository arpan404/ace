import { codeAnnotationLimit, type CodeAnnotation } from "@ace/ui-core";

/*
 * The draft's code annotations as a list: numbered 1…n in the order they were made, closing
 * ranks when one leaves, as the Browser's markers do. Pure.
 */

/** A code annotation as the editor saves it: the draft gives a new one its number. */
export type CodeAnnotationInput = Omit<CodeAnnotation, "number"> & { number?: number | undefined };

/** Where an annotation's range is now, after edits to its file. */
export interface CodeAnnotationMove {
  id: string;
  start: CodeAnnotation["start"];
  end: CodeAnnotation["end"];
  outdated?: boolean | undefined;
}

/** `list` with `input` updated in place, or added last; unchanged when full. */
export function withCode(
  list: readonly CodeAnnotation[],
  input: CodeAnnotationInput,
): readonly CodeAnnotation[] {
  const at = list.findIndex((each) => each.id === input.id);
  if (at >= 0) {
    const kept = list[at];
    if (!kept) return list;
    return list.with(at, { ...input, number: kept.number });
  }
  if (list.length >= codeAnnotationLimit) return list;
  return [...list, { ...input, number: list.length + 1 }];
}

/** `list` without `ids`, numbered 1…n again in order; the same list when none of them is in it. */
export function withoutCode(
  list: readonly CodeAnnotation[],
  ids: ReadonlySet<string> | "all",
): readonly CodeAnnotation[] {
  if (ids === "all") return list.length ? [] : list;
  if (!list.some((each) => ids.has(each.id))) return list;
  return numberedCode(list.filter((each) => !ids.has(each.id)));
}

/** The first `codeAnnotationLimit` of `list`, numbered 1…n in order. */
export function numberedCode(list: readonly CodeAnnotation[]): readonly CodeAnnotation[] {
  const numbered: CodeAnnotation[] = [];
  for (const each of list.slice(0, codeAnnotationLimit)) {
    const number = numbered.length + 1;
    numbered.push(each.number === number ? each : Object.assign({}, each, { number }));
  }
  return numbered;
}

const samePosition = (a: CodeAnnotation["start"], b: CodeAnnotation["start"]) =>
  a.line === b.line && a.column === b.column;

/** `list` with each moved range in place; the same list when nothing actually moved. */
export function movedCode(
  list: readonly CodeAnnotation[],
  moves: readonly CodeAnnotationMove[],
): readonly CodeAnnotation[] {
  const byId = new Map(moves.map((move) => [move.id, move]));
  let changed = false;
  const next = list.map((each) => {
    const move = byId.get(each.id);
    if (!move) return each;
    const outdated = move.outdated ? true : undefined;
    if (
      samePosition(each.start, move.start) &&
      samePosition(each.end, move.end) &&
      each.outdated === outdated
    )
      return each;
    changed = true;
    const moved: CodeAnnotation = { ...each, start: move.start, end: move.end };
    if (outdated) moved.outdated = true;
    else delete moved.outdated;
    return moved;
  });
  return changed ? next : list;
}
