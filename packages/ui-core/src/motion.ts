/*
 * The motion system's numbers and its list choreography, shared by web and mobile. Durations
 * mirror the CSS tokens in apps/web/src/styles/motion.css; JS needs them for exit timers.
 * Pure: no timers, DOM or React here. Callers own the clock.
 */

/** Durations in ms. `fast` hover and press, `base` popovers, `slow` panels and list moves. */
export const motionMs = {
  fast: 150,
  base: 200,
  slow: 240,
  sheet: 320,
  exit: 140,
} as const;

/** Cubic-bézier control points, for platforms that take them as numbers. */
export const motionCurves = {
  ease: [0.2, 0.7, 0.2, 1],
  spring: [0.3, 1.25, 0.5, 1],
  sheet: [0.32, 0.72, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/** Above this many rows entering or leaving at once, a change is a reset, not a motion. */
export const bulkChange = 8;

/** How a keyed list changed between two renders. */
export interface ListChange {
  /** Keys that were not in the previous list. */
  entered: string[];
  /** Keys of the previous list that are gone, with where they were. */
  left: { key: string; index: number }[];
  /** Rows that stayed changed their relative order. */
  reordered: boolean;
  /** Too much changed to animate row by row: a filter flip, or the list's first fill. */
  bulk: boolean;
}

/** What happened to a keyed list, so rows can enter, leave and slide instead of jumping. */
export function diffList(previous: readonly string[], next: readonly string[]): ListChange {
  const before = new Set(previous);
  const after = new Set(next);
  const entered = next.filter((key) => !before.has(key));
  const left: ListChange["left"] = [];
  previous.forEach((key, index) => {
    if (!after.has(key)) left.push({ key, index });
  });
  const keptBefore = previous.filter((key) => after.has(key));
  const keptAfter = next.filter((key) => before.has(key));
  const reordered = keptBefore.some((key, index) => keptAfter[index] !== key);
  // A list filling up from nothing is a load, not news: nothing rises in.
  const bulk = previous.length === 0 || entered.length + left.length > bulkChange;
  return { entered, left, reordered, bulk };
}

/**
 * The list to draw while rows leave: the new keys with each leaving key put back where it was,
 * so it can fade out in place before its neighbours close the gap. Leaving keys that came back
 * are drawn once, as present rows.
 */
export function withLeaving(
  next: readonly string[],
  leaving: readonly { key: string; index: number }[],
): string[] {
  const present = new Set(next);
  const merged = [...next];
  const ghosts = leaving
    .filter((ghost) => !present.has(ghost.key))
    .toSorted((a, b) => a.index - b.index);
  for (const ghost of ghosts) merged.splice(Math.min(ghost.index, merged.length), 0, ghost.key);
  return merged;
}
