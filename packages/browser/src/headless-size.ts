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

/**
 * A tab's CSS viewport, at the browser's own device scale, and its window to match. Zoom works as
 * a browser's page zoom: the page lays out in `viewport / zoom` CSS pixels drawn `zoom` times
 * larger, so the window and its frames keep their size.
 */
export async function sizeHeadlessTab(
  cdp: BrowserCdp,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
  zoom = 1,
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: Math.max(1, Math.round(viewport.width / zoom)),
    height: Math.max(1, Math.round(viewport.height / zoom)),
    deviceScaleFactor: deviceScaleFactor * zoom,
    mobile: false,
  });
  await sizeHeadlessContents(cdp, viewport.width, viewport.height);
}
