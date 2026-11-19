/*
 * The /spade/ page's key rule for a row of choices (the face maker's options): the arrows step
 * along it, wrapping, and Home and End jump to its ends.
 */

/** The tab a key moves to from `index` among `count`, wrapping; undefined for other keys. */
export function tabAfter(key: string, index: number, count: number): number | undefined {
  const last = count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return index >= last ? 0 : index + 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return index <= 0 ? last : index - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  return undefined;
}
