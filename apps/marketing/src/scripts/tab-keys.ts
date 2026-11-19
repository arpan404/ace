/*
 * Which tab a key moves to in a tab list: the arrows step and wrap, Home and End jump to the
 * ends. Pure, so scripts/tabs.ts can stay a thin DOM shell.
 */

/** The tab `key` moves to from `index` among `count`, or undefined when the key isn't one. */
export function tabForKey(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** The tab to open first: the one named `wanted` if there is one, else the first. */
export function firstTab(names: readonly string[], wanted: string | undefined): number {
  const at = wanted === undefined ? -1 : names.indexOf(wanted);
  return at < 0 ? 0 : at;
}
