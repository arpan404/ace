import { ReviewFingerprint, type ReviewFingerprint as Fingerprint } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";
import type { LineRange } from "./file-diff.tsx";

/** Known contiguous lines on either side. Repeated patch coordinates fail closed. */
export function linesOf(file: FileDiff, range: LineRange): string[] | undefined {
  const lines: string[] = [];
  for (const row of file.rows)
    for (const line of row.kind === "fold" ? (row.lines ?? []) : [row]) {
      const number = range.side === "old" ? line.old : line.new;
      if (number !== undefined && number >= range.start && number <= range.end)
        lines.push(line.text);
    }
  return lines.length === range.end - range.start + 1 ? lines : undefined;
}

/** Capture the displayed selection and available context, within the protocol's bounds. */
export function displayedSelection(file: FileDiff, range: LineRange): Fingerprint | undefined {
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
