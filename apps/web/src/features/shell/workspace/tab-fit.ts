/*
 * How wide each tab of a strip is drawn. The showing tab keeps its whole title (up to the cap).
 * Tabs keep their labels and scroll when crowded. Only a truly narrow strip uses icons.
 */
export const tabSizes = {
  /** No tab grows past this, however long its title. */
  max: 220,
  /** A tab folded to its icon. */
  icon: 36,
} as const;

export interface TabMeasure {
  key: string;
  /** Icon, whole title, badge and close room, unconstrained. */
  natural: number;
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

/** Labels keep their natural width; a very narrow strip uses icon tooltips. */
export function fitTabs(
  tabs: readonly TabMeasure[],
  active: string | undefined,
  available: number,
): TabFit {
  const widths = new Map<string, number>();
  const icons = new Set<string>();
  const clipped = new Set<string>();
  for (const tab of tabs) {
    const iconOnly = available < 160 && tab.key !== active;
    const width = iconOnly ? tabSizes.icon : Math.ceil(Math.min(tab.natural, tabSizes.max));
    widths.set(tab.key, width);
    if (iconOnly) icons.add(tab.key);
    else if (width < tab.natural) clipped.add(tab.key);
  }
  return { widths, icons, clipped, dots: new Set() };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...b].every((key) => a.has(key));

export function sameFit(a: TabFit | undefined, b: TabFit): boolean {
  if (!a || a.widths.size !== b.widths.size) return false;
  for (const [key, width] of b.widths) if (a.widths.get(key) !== width) return false;
  return sameSet(a.icons, b.icons) && sameSet(a.dots, b.dots) && sameSet(a.clipped, b.clipped);
}
