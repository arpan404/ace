/**
 * A bounded overview: long threads never mount or fetch one element per turn. `limit` is how
 * many ticks fit the rail's height, so the rail never scrolls; the reader's turn always shows.
 */
export function railOrdinals(count: number, current: number, limit = 79): readonly number[] {
  if (count <= 0) return [];
  // One place stays free for the reader's turn when it falls between the evenly spread ones.
  const size = Math.min(count, Math.max(2, Math.min(limit, 79) - 1));
  const ordinals = new Set<number>();
  for (let index = 0; index < size; index++)
    ordinals.add(size === 1 ? 1 : 1 + Math.round((index * (count - 1)) / (size - 1)));
  ordinals.add(Math.max(1, Math.min(count, current)));
  return [...ordinals].toSorted((a, b) => a - b);
}
