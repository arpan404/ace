import { findComposerInput } from "@/lib/focus-composer.ts";

/**
 * The window's regions, in the order F6 visits them: the thread list in the sidebar, the main
 * view, the side panel when it shows, and the composer. ⇧F6 walks back.
 */
export const regionOrder = ["sidebar", "main", "panel", "composer"] as const;
export type Region = (typeof regionOrder)[number];

/**
 * The region `step` places from `current` among those on screen, wrapping round. From outside
 * every region (focus on the page itself), F6 starts at the first and ⇧F6 at the last.
 */
export function stepRegion(
  present: readonly Region[],
  current: Region | undefined,
  step: 1 | -1,
): Region | undefined {
  const shown = regionOrder.filter((region) => present.includes(region));
  if (!shown.length) return undefined;
  const at = current === undefined ? -1 : shown.indexOf(current);
  if (at < 0) return step > 0 ? shown[0] : shown.at(-1);
  return shown[(at + step + shown.length) % shown.length];
}

/** Put away, though still in the document: a collapsed sidebar, an inert or hidden subtree. */
const away = '[inert], [aria-hidden="true"], [hidden], [data-collapsible="offcanvas"]';

const containers: Record<Exclude<Region, "composer">, string> = {
  sidebar: '[data-focus-region="sidebar"]',
  main: "#main",
  panel: '[data-focus-region="panel"]',
};

function container(doc: Document, region: Region): HTMLElement | null {
  if (region === "composer") return findComposerInput(doc);
  const found = doc.querySelector<HTMLElement>(containers[region]);
  return found && !found.closest(away) ? found : null;
}

const tabbable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function firstTabbable(root: HTMLElement): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(tabbable))
    if (!element.closest(away)) return element;
  return null;
}

/** Where focus lands in a region: its own stop, never a control picked at random. */
function target(doc: Document, region: Region): HTMLElement | null {
  const root = container(doc, region);
  if (!root) return null;
  switch (region) {
    case "sidebar":
      // The list's one Tab stop (its roving row), else the first control in the sidebar.
      return (
        root.querySelector<HTMLElement>('[role="list"][aria-label="Threads"] [tabindex="0"]') ??
        firstTabbable(root)
      );
    case "panel":
      return (
        root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? firstTabbable(root)
      );
    default:
      return root;
  }
}

/** The region holding `element`; the composer first, since it sits inside the main view. */
export function regionOf(doc: Document, element: Element | null): Region | undefined {
  if (!element) return undefined;
  if (element.closest('[data-slot="composer"]')) return "composer";
  if (element.closest(containers.panel)) return "panel";
  if (element.closest(containers.sidebar)) return "sidebar";
  if (element.closest(containers.main)) return "main";
  return undefined;
}

/** Regions on screen now that have somewhere to put focus. */
export function presentRegions(doc: Document): Region[] {
  return regionOrder.filter((region) => target(doc, region) !== null);
}

/** Focus `region`. False when it isn't on screen. */
export function focusRegion(doc: Document, region: Region): boolean {
  const element = target(doc, region);
  if (!element) return false;
  element.focus({ preventScroll: region !== "sidebar" });
  return true;
}

/** Move focus to the next (or previous) region. False when there was nowhere to go. */
export function cycleRegion(doc: Document, step: 1 | -1): boolean {
  const next = stepRegion(presentRegions(doc), regionOf(doc, doc.activeElement), step);
  return next !== undefined && focusRegion(doc, next);
}
