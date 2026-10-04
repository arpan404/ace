/*
 * How wide each tab of a strip is drawn. The showing tab keeps its whole title (up to the cap).
 * Short of room, the others first narrow evenly down to a readable title; then the pinned tools
 * (Changes, Agents) fold to their icons together, then the other tabs, furthest from the showing
 * one first. Only once every other tab is an icon does the strip scroll. So a strip has at most
 * two looks at once: titled tabs of one width, and icons.
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
  /** A pinned per-thread tool (Changes, Agents): these fold first, and together. */
  tool?: boolean;
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
  const distance = (tab: TabMeasure) => Math.abs(tabs.indexOf(tab) - at);
  // Each step folds one group: the pinned tools together, then one tab at a time, the furthest
  // from the showing tab first, so its neighbours keep their titles longest.
  const tools = others.filter((tab) => tab.tool);
  const rest = others.filter((tab) => !tab.tool).toSorted((a, b) => distance(b) - distance(a));
  const steps: (readonly TabMeasure[])[] = [
    ...(tools.length ? [tools] : []),
    ...rest.map((tab) => [tab]),
  ];
  const icons = new Set<string>();
  const capFor = () =>
    waterLevel(
      others.filter((tab) => !icons.has(tab.key)).map((tab) => want(tab)),
      budget - icons.size * tabSizes.icon,
    );
  let cap = capFor();
  // A titled tab narrower than this shows too little of its title (or none, past its badge).
  const cramped = () =>
    others.some(
      (tab) =>
        !icons.has(tab.key) &&
        cap < Math.min(want(tab), Math.max(tab.least ?? 0, tabSizes.labelled)),
    );
  for (const step of steps) {
    if (!cramped()) break;
    for (const tab of step) icons.add(tab.key);
    cap = capFor();
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
