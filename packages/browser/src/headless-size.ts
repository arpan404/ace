import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { longestFrameSide } from "./capture-policy.ts";

/** Size the compositor too: an emulated CSS viewport alone can leave the capture cropped. */
export async function sizeHeadlessContents(
  cdp: BrowserCdp,
  width: number,
  height: number,
): Promise<void> {
  const { windowId } = z
    .object({ windowId: z.number().int() })
    .parse(await cdp.send("Browser.getWindowForTarget"));
  await cdp.send("Browser.setContentsSize", { windowId, width, height });
}

/** A device a headless tab emulates in place of the size the pane gives it. */
export interface HeadlessDevice {
  width: number;
  height: number;
  /** 0 keeps the browser's own device scale. */
  deviceScaleFactor: number;
  mobile: boolean;
}

/** How a tab is shown: the pane's size or a device's, at a page zoom (1 is 100%). */
export interface HeadlessMetrics {
  viewport: { width: number; height: number };
  zoom?: number | undefined;
  device?: HeadlessDevice | undefined;
}

/** The sharpest a page renders for a viewer: its screen's density, from the browser's up to 3. */
export const maxSourceScale = 3;

/**
 * How many window pixels stand for one CSS pixel of the pane: 1 at the browser's own scale,
 * more for a denser screen. Device emulation keeps its own scale and the window's size.
 */
export function contentsScale(
  metrics: HeadlessMetrics,
  browserScale: number,
  viewerScale = browserScale,
): number {
  if (metrics.device) return 1;
  // No sharper than the largest frame the capture sends (`capture-policy.ts`).
  const longest = Math.max(metrics.viewport.width, metrics.viewport.height);
  const wanted = Math.min(maxSourceScale, viewerScale, longestFrameSide / longest);
  return Math.max(browserScale, wanted) / browserScale;
}

/**
 * The emulation a headless tab gets. Chrome has no CDP page zoom, so zoom is what a browser's
 * zoom does to the page: the CSS viewport shrinks by the factor and the device scale grows by
 * it, while the picture keeps the size it had. The window keeps the unzoomed size.
 *
 * The screencast draws the window at the browser's process-wide scale and ignores an emulated
 * one, so a viewer whose screen is denser than that scale gets a larger window instead: the
 * page keeps its CSS size at the denser device scale, and the window's pixels match it.
 */
export function headlessOverride(
  metrics: HeadlessMetrics,
  browserScale: number,
  viewerScale = browserScale,
) {
  const zoom = metrics.zoom ?? 1;
  const base = metrics.device ?? { ...metrics.viewport, deviceScaleFactor: 0, mobile: false };
  const enlarge = contentsScale(metrics, browserScale, viewerScale);
  const scale = base.deviceScaleFactor || browserScale * enlarge;
  return {
    override: {
      width: Math.max(1, Math.round(base.width / zoom)),
      height: Math.max(1, Math.round(base.height / zoom)),
      deviceScaleFactor: Math.min(8, Math.max(0.25, scale * zoom)),
      mobile: base.mobile,
    },
    contents: {
      width: Math.round(base.width * enlarge),
      height: Math.round(base.height * enlarge),
    },
  };
}

/** A tab's CSS viewport, as sharp as its viewer's screen allows, and its window to match. */
export async function sizeHeadlessTab(
  cdp: BrowserCdp,
  metrics: HeadlessMetrics,
  deviceScaleFactor: number,
  viewerScale = deviceScaleFactor,
): Promise<void> {
  const { override, contents } = headlessOverride(metrics, deviceScaleFactor, viewerScale);
  await cdp.send("Emulation.setDeviceMetricsOverride", override);
  await sizeHeadlessContents(cdp, contents.width, contents.height);
}
