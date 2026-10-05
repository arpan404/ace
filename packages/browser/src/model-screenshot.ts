import { modelImageGeometry } from "@ace/mcp-server";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Viewport = z.object({
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: z.number().positive(),
    clientHeight: z.number().positive(),
  }),
});
const Density = z.object({ result: z.object({ value: z.number().positive() }) });
/** Keep model images within 1536 pixels without resizing the page or its layout. */
export async function modelScreenshot(cdp: BrowserCdp): Promise<Buffer> {
  const viewport = Viewport.parse(await cdp.send("Page.getLayoutMetrics")).cssVisualViewport;
  const density = Density.parse(
    await cdp.send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    }),
  ).result.value;
  const geometry = modelImageGeometry(viewport.clientWidth, viewport.clientHeight);
  const scale = geometry.scale / density;
  const result = z.object({ data: z.string().max(768 * 1024) }).parse(
    await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      captureBeyondViewport: false,
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale,
      },
    }),
  );
  return Buffer.from(result.data, "base64");
}
