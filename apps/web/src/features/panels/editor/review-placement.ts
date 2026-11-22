import {
  locateHunk,
  mapHunk,
  type ChangeHunk,
  type TurnHunk,
  type WholeLineChange,
} from "@ace/ui-core";

/*
 * Where a reviewed turn's hunk is in the text now, and whether Revert may act on it. Only a hunk
 * carried by the exact changes from the turn's own text to the text now is proven to be the
 * turn's lines: one found by its words (a turn known only by its patch) may be a copy, so it is
 * shown but never reverted. Pure.
 */

export type HunkSource =
  /** The turn recorded the file's text: the changes from it to the text now (undefined: loading). */
  | { kind: "text"; changes: readonly WholeLineChange[] | undefined }
  /** Only the turn's patch is known: the hunk can be looked for by its words, not proven. */
  | { kind: "patch"; lineAt(line: number): string; lineCount: number };

export function placeHunk(
  hunk: TurnHunk,
  source: HunkSource,
): { at: ChangeHunk; revertable: boolean } | undefined {
  if (source.kind === "text") {
    const at = source.changes && mapHunk(hunk, source.changes);
    return at && { at, revertable: true };
  }
  const at = locateHunk(hunk, source.lineAt, source.lineCount);
  return at && { at, revertable: false };
}

/** A turn's exact hunks, worked out for one text before and after it. */
export interface ExactHunks {
  before: string;
  after: string;
  hunks: readonly TurnHunk[];
}

/** The cached hunks when they are for this very turn's texts; undefined while they load. */
export function cachedExact(
  cache: ExactHunks | undefined,
  texts: { before: string; after: string },
): readonly TurnHunk[] | undefined {
  return cache?.before === texts.before && cache.after === texts.after ? cache.hunks : undefined;
}
