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
