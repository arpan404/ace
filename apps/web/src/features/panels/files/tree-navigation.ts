import type { FolderRow } from "@ace/ui-core";

/**
 * Each row's place among its siblings (1-based) and how many siblings there are, for
 * `aria-posinset` and `aria-setsize`. The tree is drawn flat (and only partly mounted), so a
 * screen reader can't count a folder's children itself. Rows come in tree order: a row belongs
 * to the last row one level above it. Linear in the rows shown.
 */
export function siblingPositions(
  rows: readonly FolderRow[],
): Map<string, { position: number; size: number }> {
  const parents: number[] = [];
  const counts = new Map<number, number>();
  const groupOf = new Map<string, number>();
  const positions = new Map<string, { position: number; size: number }>();
  rows.forEach((row, index) => {
    parents[row.depth] = index;
    const group = row.depth === 0 ? -1 : (parents[row.depth - 1] ?? -1);
    const position = (counts.get(group) ?? 0) + 1;
    counts.set(group, position);
    groupOf.set(row.key, group);
    positions.set(row.key, { position, size: 0 });
  });
  for (const [key, place] of positions) place.size = counts.get(groupOf.get(key) ?? -1) ?? 0;
  return positions;
}

/** How long a pause between letters starts a new type-ahead name. */
const typeAheadPause = 1000;

/** The letters typed so far on the tree's rows, and when the last one came. */
export interface TypeAhead {
  text: string;
  at: number;
}

/**
 * The row type-ahead lands on: the first one after `index` (or at it, while a name is being
 * typed) whose name starts with the letters, wrapping round. Updates `typed` in place.
 */
export function typeAheadMatch(
  typed: TypeAhead,
  rows: readonly FolderRow[],
  index: number,
  letter: string,
  at: number,
): FolderRow | undefined {
  const fresh = at - typed.at > typeAheadPause;
  typed.text = (fresh ? "" : typed.text) + letter.toLowerCase();
  typed.at = at;
  // A single letter moves on from the current row; a longer name may still be this row.
  const start = typed.text.length === 1 ? index + 1 : index;
  for (let step = 0; step < rows.length; step++) {
    const candidate = rows[(start + step) % rows.length];
    if (candidate?.kind !== "file" && candidate?.kind !== "folder") continue;
    if (candidate.name.toLowerCase().startsWith(typed.text)) return candidate;
  }
  return undefined;
}

/** Whether type-ahead is mid-name, so a space is part of it rather than opening the row. */
export function typingName(typed: TypeAhead, at: number): boolean {
  return typed.text.length > 0 && at - typed.at <= typeAheadPause;
}
