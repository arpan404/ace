import { ReviewFingerprint, type ReviewFingerprint as Fingerprint } from "@ace/protocol";
import type { FileDiff } from "./turns.ts";

/** Lines on one side of a diff, first to last; a review comment covers fewer than 100. */
export interface LineRange {
  side: "old" | "new";
  start: number;
  end: number;
}

/** Known contiguous lines on either side. Repeated patch coordinates fail closed. */
export function linesOf(file: Pick<FileDiff, "rows">, range: LineRange): string[] | undefined {
  const lines: string[] = [];
  for (const row of file.rows)
    for (const line of row.kind === "fold" ? (row.lines ?? []) : [row]) {
      const number = range.side === "old" ? line.old : line.new;
      if (number !== undefined && number >= range.start && number <= range.end)
        lines.push(line.text);
    }
  return lines.length === range.end - range.start + 1 ? lines : undefined;
}

/**
 * The displayed selection and up to three known lines around it, within the protocol's bounds:
 * the daemon checks it against its own snapshot before recording a comment.
 */
export function displayedSelection(
  file: Pick<FileDiff, "rows">,
  range: LineRange,
): Fingerprint | undefined {
  const lines = linesOf(file, range);
  if (!lines) return undefined;
  const before: string[] = [];
  const after: string[] = [];
  for (let number = range.start - 1; number >= Math.max(1, range.start - 3); number--) {
    const known = linesOf(file, { ...range, start: number, end: number });
    if (!known) break;
    before.unshift(...known);
  }
  for (let number = range.end + 1; number <= range.end + 3; number++) {
    const known = linesOf(file, { ...range, start: number, end: number });
    if (!known) break;
    after.push(...known);
  }
  const parsed = ReviewFingerprint.safeParse({ before, lines, after });
  return parsed.success ? parsed.data : undefined;
}
