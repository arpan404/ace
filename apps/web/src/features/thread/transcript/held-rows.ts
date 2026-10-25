/*
 * Which rows the transcript draws while rows land above the one the reader holds. The
 * virtualizer picks its rows from the scroll offset it last saw, but rows landing above (a page
 * of older history) push the reader's row further down the list before the view is moved to
 * follow it. Drawn from the old offset, that render would show whatever now sits there and drop
 * the rows on screen, then mount them again once the view moves: they lose what they had
 * loaded and settle again under the reader's eyes. Pure: positions in, row indexes out.
 */

/** A row's place in the list, as the virtualizer measures it. */
export interface Placed {
  start: number;
  end: number;
}

/**
 * The rows in view when row `index` sits `top` below the view's top (negative: it starts above
 * it), and `overscan` more on each side, in order.
 */
export function rowsAround(
  rows: readonly Placed[],
  index: number,
  top: number,
  height: number,
  overscan: number,
): number[] {
  const held = rows[index];
  if (!held) return [];
  const from = held.start - top;
  const to = from + height;
  let first = index;
  while (first > 0 && (rows[first - 1]?.end ?? 0) > from) first--;
  let last = index;
  while (last < rows.length - 1 && (rows[last + 1]?.start ?? to) < to) last++;
  const start = Math.max(0, first - overscan);
  const end = Math.min(rows.length - 1, last + overscan);
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

/**
 * The rows to draw: the virtualizer's own (`drawn`), and the rows around the held row where they
 * are missing from it. Both, sorted, so neither the rows on screen nor the ones the virtualizer
 * expects are dropped for the moment the two disagree.
 */
export function withHeldRows(drawn: readonly number[], around: readonly number[]): number[] {
  if (around.length === 0) return [...drawn];
  const have = new Set(drawn);
  if (around.every((index) => have.has(index))) return [...drawn];
  for (const index of around) have.add(index);
  return [...have].toSorted((a, b) => a - b);
}
