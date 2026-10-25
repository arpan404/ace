/*
 * Which rows the transcript draws: enough around the view to cover a fast flick, and the rows
 * around the one the reader holds while rows land above it. The
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
 * The rows to draw around the rows in view (`startIndex` to `endIndex`): `overscan` more on each
 * side, and at least as many as reach `reach` pixels past the view's edges. Short rows (a step
 * line, a "Worked for" line) cover little ground each, and a fast flick that outruns the drawn
 * rows shows an empty strip until the next render catches up.
 */
export function rowsWithin(
  rows: readonly Placed[],
  range: { startIndex: number; endIndex: number; overscan: number },
  reach: number,
): number[] {
  const { startIndex, endIndex, overscan } = range;
  if (rows.length === 0 || startIndex > endIndex) return [];
  const top = (rows[startIndex]?.start ?? 0) - reach;
  const bottom = (rows[endIndex]?.end ?? 0) + reach;
  let start = Math.max(0, startIndex - overscan);
  while (start > 0 && (rows[start - 1]?.end ?? 0) > top) start--;
  let end = Math.min(rows.length - 1, endIndex + overscan);
  while (end < rows.length - 1 && (rows[end + 1]?.start ?? bottom) < bottom) end++;
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
