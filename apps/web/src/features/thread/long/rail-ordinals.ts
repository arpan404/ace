/**
 * A bounded overview: long threads never mount or fetch one element per turn. `limit` is how
 * many ticks fit the rail's height, so the rail never scrolls; the turns in view, `current`
 * through `last`, always show (up to half the rail, nearest the reader's turn first).
 */
export function railOrdinals(
  count: number,
  current: number,
  limit = 79,
  last = current,
): readonly number[] {
  if (count <= 0) return [];
  const cap = Math.max(2, Math.min(limit, 79));
  const from = Math.max(1, Math.min(count, current));
  const to = Math.max(from, Math.min(count, last));
  const inView = Math.min(to - from + 1, Math.max(1, Math.floor(cap / 2)));
  // Places stay free for the turns in view when they fall between the evenly spread ones.
  const size = Math.min(count, Math.max(2, cap - inView));
  const ordinals = new Set<number>();
  for (let index = 0; index < size; index++)
    ordinals.add(size === 1 ? 1 : 1 + Math.round((index * (count - 1)) / (size - 1)));
  for (let ordinal = from; ordinal < from + inView; ordinal++) ordinals.add(ordinal);
  return [...ordinals].toSorted((a, b) => a - b);
}
