import type { FileDiff } from "./turns.ts";

/** Estimated retained UTF-16 text and row storage, including lines hidden by folds. */
export function diffBytes(diff: FileDiff): number {
  let bytes = 256 + diff.path.length * 2;
  for (const row of diff.rows) {
    bytes += 48;
    if (row.kind !== "fold") bytes += row.text.length * 2;
    else for (const line of row.lines ?? []) bytes += 48 + line.text.length * 2;
  }
  return bytes;
}
