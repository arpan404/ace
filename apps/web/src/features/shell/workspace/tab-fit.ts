/*
 * How wide each tab of a strip is drawn. The showing tab keeps its whole title (up to the cap);
 * the others share what is left, narrowing evenly, and the ones furthest from the showing tab
 * fold to their icon first. Only once every other tab is an icon does the strip scroll.
 */

export const tabSizes = {
  /** No tab grows past this, however long its title. */
  max: 220,
  /** A tab folded to its icon. */
  icon: 36,
  /** Narrower than this a title shows too few letters to read; the tab folds to its icon. */
  labelled: 72,
  /** Between two tabs. */
  gap: 2,
} as const;

export interface TabMeasure {
  key: string;
  /** Icon, whole title, badge and close room, unconstrained. */
  natural: number;
  /** Narrower than this the tab folds to its icon (a badge leaves less room for the title). */
  least?: number;
}

export interface TabFit {
  /** Whole pixels per tab. */
  widths: ReadonlyMap<string, number>;
  /** Tabs drawn as their icon alone. */
  icons: ReadonlySet<string>;
}

/** The cap that shares `budget` among `wants`: each gets its want or the cap, whichever is less. */
function waterLevel(wants: readonly number[], budget: number): number {
  const sorted = wants.toSorted((a, b) => a - b);
  let left = budget;
  for (const [index, want] of sorted.entries()) {
    const share = left / (sorted.length - index);
    if (want > share) return Math.floor(share);
    left -= want;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Widths for `tabs` in `available` pixels, `active` being the showing tab. Pure, so the strip's
 * layout pass and its tests share it.
 */
export function fitTabs(
  tabs: readonly TabMeasure[],
  active: string | undefined,
  available: number,
): TabFit {
  const want = (tab: TabMeasure) => Math.ceil(Math.min(tab.natural, tabSizes.max));
  const room = available - tabSizes.gap * Math.max(0, tabs.length - 1);
  const shown = tabs.find((tab) => tab.key === active);
  const others = tabs.filter((tab) => tab !== shown);
  const budget = room - (shown ? want(shown) : 0);
  const at = shown ? tabs.indexOf(shown) : 0;
  // Fold the furthest from the showing tab first, so its neighbours keep their titles longest.
  const foldOrder = others.toSorted(
    (a, b) => Math.abs(tabs.indexOf(b) - at) - Math.abs(tabs.indexOf(a) - at),
  );
  const icons = new Set<string>();
  let cap = waterLevel(
    others.map((tab) => want(tab)),
    budget,
  );
  const cramped = () =>
    others.some(
      (tab) =>
        !icons.has(tab.key) &&
        cap < Math.min(want(tab), Math.max(tab.least ?? 0, tabSizes.labelled)),
    );
  for (const tab of foldOrder) {
    if (!cramped()) break;
    icons.add(tab.key);
    const labelled = others.filter((each) => !icons.has(each.key));
    cap = waterLevel(
      labelled.map((each) => want(each)),
      budget - icons.size * tabSizes.icon,
    );
  }
  const widths = new Map<string, number>();
  for (const tab of tabs)
    widths.set(
      tab.key,
      tab === shown ? want(tab) : icons.has(tab.key) ? tabSizes.icon : Math.min(want(tab), cap),
    );
  return { widths, icons };
}

export function sameFit(a: TabFit | undefined, b: TabFit): boolean {
  if (!a || a.widths.size !== b.widths.size || a.icons.size !== b.icons.size) return false;
  for (const [key, width] of b.widths) if (a.widths.get(key) !== width) return false;
  for (const key of b.icons) if (!a.icons.has(key)) return false;
  return true;
}
