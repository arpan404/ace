import type { FileChange } from "@ace/protocol";
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

/**
 * The file's text before and after the turn, when the turn recorded both for certain: an update
 * (or move) must carry the text before it, and only a file the turn created starts from nothing;
 * each later change must start from the one before's result. Otherwise undefined: Revert stays off
 * rather than guess a baseline.
 */
export function turnTexts(
  changes: readonly FileChange[],
): { before: string; after: string } | undefined {
  const first = changes[0];
  if (!first) return undefined;
  const before =
    typeof first.oldText === "string" ? first.oldText : first.kind === "add" ? "" : undefined;
  if (before === undefined) return undefined;
  let text = before;
  for (const [index, change] of changes.entries()) {
    if (change.kind === "delete" || change.newText === undefined) return undefined;
    if (index > 0 && change.oldText !== text) return undefined;
    text = change.newText;
  }
  return { before, after: text };
}

/** The turn's one patch of the file, when that is all it recorded. */
export function singlePatch(changes: readonly FileChange[]): string | undefined {
  const [only, ...rest] = changes;
  return only && rest.length === 0 && only.newText === undefined
    ? (only.diff ?? undefined)
    : undefined;
}
