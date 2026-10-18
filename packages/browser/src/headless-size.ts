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

/** A tab's CSS viewport, at the browser's own device scale, and its window to match. */
export async function sizeHeadlessTab(
  cdp: BrowserCdp,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor,
    mobile: false,
  });
  await sizeHeadlessContents(cdp, viewport.width, viewport.height);
}
