import { useEffect } from "react";

/** The part of a TanStack Virtual virtualizer this touches. */
interface MeasuredSizes {
  itemSizeCache: Map<unknown, number>;
}

/** Forgets measured sizes once the cache holds this many more keys than the list. */
const slack = 64;

/**
 * TanStack Virtual remembers the measured size of every row key it has ever seen and never
 * forgets one. A list whose keys keep changing (a transcript streaming for hours, rows scrolled
 * out of a bounded window) would hold every key forever; this drops the keys no longer in the
 * list once the cache is well past the list's size. Rows still in the list keep their sizes.
 */
export function useForgetGoneRows(
  virtualizer: MeasuredSizes,
  count: number,
  keyAt: (index: number) => unknown,
): void {
  // Reads and trims the virtualizer's cache after every render; nothing to memoise.
  "use no memo";
  useEffect(() => {
    const cache = virtualizer.itemSizeCache;
    if (cache.size <= count * 2 + slack) return;
    const present = new Set<unknown>();
    for (let index = 0; index < count; index++) present.add(keyAt(index));
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
  });
}
