/**
 * Sort keys native orders rows by. Each row keeps the number it was sent while rows are added or
 * removed around it: the list is anchored on its last row native already has, so older history
 * paged in above takes smaller (even negative) numbers instead of renumbering every row below,
 * which would cost a position patch per row per page, and rows added at the end move nothing.
 * Native only sorts by these numbers.
 *
 * Returns what to subtract from a row's array index to get its sort key.
 */
export function anchoredOffset(
  previous: ReadonlyMap<string, number>,
  next: readonly string[],
): number {
  for (let index = next.length - 1; index >= 0; index--) {
    const key = next[index];
    const sent = key === undefined ? undefined : previous.get(key);
    if (sent !== undefined) return index - sent;
  }
  return 0;
}
