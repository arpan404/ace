import { patchRows } from "./review-draft-move.ts";

/** Most code lines of a thread's hunk kept: the lines leading to the commented line. */
export const hunkTailLines = 12;
const maxLineLength = 1_000;

/**
 * The last `keep` lines of GitHub's diff hunk for a thread, under a header recomputed for
 * them, so each line still knows its numbers. GitHub's hunk ends at the commented line. A hunk
 * that doesn't parse reads as missing.
 */
export function hunkTail(hunk: string, keep = hunkTailLines): string | undefined {
  const { rows } = patchRows(hunk);
  if (!rows.length) return undefined;
  const kept = rows.slice(-keep);
  const first = rows.length - kept.length;
  // The first old and new line numbers at or after the cut, as the header names them.
  const before = rows.slice(0, first);
  const nextLeft =
    kept.find((r) => r.left !== undefined)?.left ??
    (before.findLast((r) => r.left !== undefined)?.left ?? 0) + 1;
  const nextRight =
    kept.find((r) => r.right !== undefined)?.right ??
    (before.findLast((r) => r.right !== undefined)?.right ?? 0) + 1;
  const lefts = kept.filter((r) => r.left !== undefined).length;
  const rights = kept.filter((r) => r.right !== undefined).length;
  const header = `@@ -${lefts ? nextLeft : nextLeft - 1},${lefts} +${rights ? nextRight : nextRight - 1},${rights} @@`;
  return [header, ...kept.map((r) => `${r.kind}${r.text.slice(0, maxLineLength)}`)].join("\n");
}

export type HunkRow = { kind: "-" | "+" | " "; left?: number; right?: number; text: string };

/** A thread's hunk as rows with their old and new line numbers; none when it doesn't parse. */
export function hunkRows(hunk: string | undefined): HunkRow[] {
  return hunk ? patchRows(hunk).rows : [];
}
