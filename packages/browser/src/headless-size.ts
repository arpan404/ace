import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

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

/**
 * The emulation a headless tab gets. Chrome has no CDP page zoom, so zoom is what a browser's
 * zoom does to the page: the CSS viewport shrinks by the factor and the device scale grows by
 * it, while the picture keeps the size it had. The window keeps the unzoomed size.
 */
export function headlessOverride(metrics: HeadlessMetrics, browserScale: number) {
  const zoom = metrics.zoom ?? 1;
  const base = metrics.device ?? { ...metrics.viewport, deviceScaleFactor: 0, mobile: false };
  const scale = base.deviceScaleFactor || browserScale;
  return {
    override: {
      width: Math.max(1, Math.round(base.width / zoom)),
      height: Math.max(1, Math.round(base.height / zoom)),
      deviceScaleFactor: Math.min(8, Math.max(0.25, scale * zoom)),
      mobile: base.mobile,
    },
    contents: { width: base.width, height: base.height },
  };
}

/** A tab's CSS viewport, at the browser's own device scale, and its window to match. */
export async function sizeHeadlessTab(
  cdp: BrowserCdp,
  metrics: HeadlessMetrics,
  deviceScaleFactor: number,
  zoom = 1,
): Promise<void> {
  const { override, contents } = headlessOverride(metrics, deviceScaleFactor);
  await cdp.send("Emulation.setDeviceMetricsOverride", override);
  await sizeHeadlessContents(cdp, contents.width, contents.height);
}
