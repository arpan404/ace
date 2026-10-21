import type { BrowserView } from "../sources.ts";

/** The page picture-in-picture keeps on screen. */
export interface PipPage {
  tabId: string;
  url: string;
  title: string;
  favicon?: string | undefined;
}

/**
 * Whether the thread's page floats in picture-in-picture, and which: the tab the person views,
 * while the Browser isn't showing in the panel, as long as an agent browses (any tab in use) or
 * that tab plays sound. Not for a closed, paused or blank browser, nor once the person dismissed
 * it (until the Browser shows again), nor ever while they turned picture-in-picture off.
 */
export function pipPage(input: {
  view: BrowserView | undefined;
  showingBrowser: boolean;
  dismissed: boolean;
  /** Settings › Browser › Picture in picture. */
  enabled: boolean;
}): PipPage | undefined {
  const { view } = input;
  if (!input.enabled || input.showingBrowser || input.dismissed || !view || view.closed)
    return undefined;
  if (view.status === "paused" || view.status === "recovering") return undefined;
  const tabs = view.tabs ?? [];
  const shown = tabs.find((tab) => tab.tabId === view.activeTabId);
  if (!shown || !shown.url || shown.url === "about:blank") return undefined;
  const browsing = tabs.some((tab) => tab.inUse?.kind === "agent");
  if (!browsing && !shown.playing) return undefined;
  return {
    tabId: shown.tabId,
    url: shown.url,
    title: shown.title || shown.url,
    favicon: shown.favicon,
  };
}

/** Where the floating window sits: its distance from the window's right and bottom edges. */
export interface PipGeometry {
  right: number;
  bottom: number;
  width: number;
}

export const pipLimits = { minWidth: 240, defaultWidth: 320, margin: 8, header: 28 } as const;
export const defaultPipGeometry: PipGeometry = { right: 16, bottom: 112, width: 320 };

/**
 * The window kept inside the app window: at least `minWidth` wide and at most half the window,
 * its whole box (header and page at `aspect` height/width) within `margin` of every edge.
 */
export function clampPip(
  geometry: PipGeometry,
  window: { width: number; height: number },
  aspect: number,
): PipGeometry {
  const { margin, minWidth, header } = pipLimits;
  const maxWidth = Math.max(
    minWidth,
    Math.min(window.width / 2, (window.height - header) / aspect),
  );
  const width = Math.round(Math.min(Math.max(geometry.width, minWidth), maxWidth));
  const height = Math.round(width * aspect) + header;
  const right = Math.round(
    Math.min(Math.max(geometry.right, margin), Math.max(margin, window.width - width - margin)),
  );
  const bottom = Math.round(
    Math.min(Math.max(geometry.bottom, margin), Math.max(margin, window.height - height - margin)),
  );
  return { right, bottom, width };
}

/** Space between stacked floating windows. */
const stackGap = 8;

/** A floating window's box: its distances from the window's right and bottom, and its size. */
export interface PipBox {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const overlaps = (a: PipBox, b: PipBox) =>
  a.right < b.right + b.width &&
  b.right < a.right + a.width &&
  a.bottom < b.bottom + b.height &&
  b.bottom < a.bottom + a.height;

/**
 * Where a new floating window starts while others are open (`open`): at `base` (where the
 * person last put one) when that is free, else the first free place stacked upward from it,
 * then in columns leftward once a column reaches the top. Always inside the app window
 * (`clampPip`); when nothing is free, at `base`.
 */
export function placePip(
  base: PipGeometry,
  open: readonly PipBox[],
  window: { width: number; height: number },
  aspect: number,
): PipGeometry {
  const first = clampPip(base, window, aspect);
  const height = Math.round(first.width * aspect) + pipLimits.header;
  const room = window.height - first.bottom - pipLimits.margin + stackGap;
  const perColumn = Math.max(1, Math.floor(room / (height + stackGap)));
  const columns = Math.max(
    1,
    Math.floor(
      (window.width - first.right - pipLimits.margin + stackGap) / (first.width + stackGap),
    ),
  );
  for (let slot = 0; slot < perColumn * columns; slot++) {
    const column = Math.floor(slot / perColumn);
    const row = slot % perColumn;
    const place = clampPip(
      {
        width: first.width,
        right: first.right + column * (first.width + stackGap),
        bottom: first.bottom + row * (height + stackGap),
      },
      window,
      aspect,
    );
    if (!open.some((box) => overlaps(box, { ...place, height }))) return place;
  }
  return first;
}
