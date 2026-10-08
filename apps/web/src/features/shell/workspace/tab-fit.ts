/*
 * How wide each tab of a strip is drawn. The showing tab keeps its whole title (up to the cap).
 * Short of room, the others first narrow evenly down to a readable title; then a badge gives way
 * to its dot (Changes' diff stat), then the pinned tools (Changes, Agents) fold to their icons
 * one at a time, the last first, then the other tabs, furthest from the showing one first. Only
 * once every other tab is an icon does the strip scroll.
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
  /** A pinned per-thread tool (Changes, Agents): these fold first. */
  tool?: boolean;
  /** Pixels its badge frees when it gives way to its dot. */
  badge?: number;
}

export interface TabFit {
  /** Whole pixels per tab. */
  widths: ReadonlyMap<string, number>;
  /** Tabs drawn as their icon alone. */
  icons: ReadonlySet<string>;
  /** Titled tabs whose badge shows as its dot. */
  dots: ReadonlySet<string>;
  /** Titled tabs drawn narrower than their title (their tooltip carries it). */
  clipped: ReadonlySet<string>;
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
  const icons = new Set<string>();
  const dots = new Set<string>();
  const saved = (tab: TabMeasure) => (dots.has(tab.key) ? (tab.badge ?? 0) : 0);
  const natural = (tab: TabMeasure) => tab.natural - saved(tab);
  const want = (tab: TabMeasure) => Math.ceil(Math.min(natural(tab), tabSizes.max));
  const room = available - tabSizes.gap * Math.max(0, tabs.length - 1);
  const shown = tabs.find((tab) => tab.key === active);
  const others = tabs.filter((tab) => tab !== shown);
  const budget = room - (shown ? want(shown) : 0);
  const at = shown ? tabs.indexOf(shown) : 0;
  const distance = (tab: TabMeasure) => Math.abs(tabs.indexOf(tab) - at);
  // Each step gives up a little more: badges become dots, then one tab at a time folds, the
  // tools first (the last of them first), then the furthest from the showing tab, so its
  // neighbours keep their titles longest.
  const badged = others.filter((tab) => (tab.badge ?? 0) > 0);
  const tools = others.filter((tab) => tab.tool).toReversed();
  const rest = others.filter((tab) => !tab.tool).toSorted((a, b) => distance(b) - distance(a));
  const steps: { tabs: readonly TabMeasure[]; to: Set<string> }[] = [
    ...(badged.length ? [{ tabs: badged, to: dots }] : []),
    ...[...tools, ...rest].map((tab) => ({ tabs: [tab], to: icons })),
  ];
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
        cap < Math.min(want(tab), Math.max((tab.least ?? 0) - saved(tab), tabSizes.labelled)),
    );
  // A badge also gives way rather than squeeze its own title ("Chan… +17 −5").
  if (badged.some((tab) => cap < want(tab))) {
    for (const tab of badged) dots.add(tab.key);
    cap = capFor();
  }
  for (const step of steps) {
    if (!cramped()) break;
    for (const tab of step.tabs) step.to.add(tab.key);
    cap = capFor();
  }
  if (shown?.tool && room - icons.size * tabSizes.icon < want(shown)) icons.add(shown.key);
  for (const key of icons) dots.delete(key);
  const widths = new Map<string, number>();
  const clipped = new Set<string>();
  for (const tab of tabs) {
    const width = icons.has(tab.key)
      ? tabSizes.icon
      : tab === shown
        ? want(tab)
        : Math.min(want(tab), cap);
    widths.set(tab.key, width);
    if (!icons.has(tab.key) && width < Math.ceil(natural(tab))) clipped.add(tab.key);
  }
  return { widths, icons, dots, clipped };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...b].every((key) => a.has(key));

export function sameFit(a: TabFit | undefined, b: TabFit): boolean {
  if (!a || a.widths.size !== b.widths.size) return false;
  for (const [key, width] of b.widths) if (a.widths.get(key) !== width) return false;
  return sameSet(a.icons, b.icons) && sameSet(a.dots, b.dots) && sameSet(a.clipped, b.clipped);
}
