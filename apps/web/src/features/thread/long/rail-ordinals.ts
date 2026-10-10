/** A bounded overview: long threads never mount or fetch one element per turn. */
export function railOrdinals(count: number, current: number): readonly number[] {
  if (count <= 0) return [];
  const size = Math.min(count, 79);
  const ordinals = new Set<number>();
  for (let index = 0; index < size; index++)
    ordinals.add(size === 1 ? 1 : 1 + Math.round((index * (count - 1)) / (size - 1)));
  ordinals.add(Math.max(1, Math.min(count, current)));
  return [...ordinals].toSorted((a, b) => a - b);
}
