import { modelImageGeometry } from "@ace/mcp-server";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Metrics = z.object({
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: z.number().positive(),
    clientHeight: z.number().positive(),
  }),
  cssContentSize: z
    .object({ width: z.number().positive(), height: z.number().positive() })
    .optional(),
});
const Density = z.object({ result: z.object({ value: z.number().positive() }) });
/** A capture area in CSS pixels of the page; omitted means the visible viewport. */
export type CaptureRegion =
  | { kind: "viewport" }
  | { kind: "page" }
  | { kind: "element"; x: number; y: number; width: number; height: number };
/** The tallest full-page capture, in CSS pixels; longer pages are cut at this height. */
const pageLimit = 16_384;

/** Where a region lies in page coordinates; element rects are viewport-relative. */
export async function captureClip(cdp: BrowserCdp, region: CaptureRegion) {
  const metrics = Metrics.parse(await cdp.send("Page.getLayoutMetrics"));
  const viewport = metrics.cssVisualViewport;
  if (region.kind === "viewport")
    return {
      x: viewport.pageX,
      y: viewport.pageY,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
  if (region.kind === "page") {
    const size = metrics.cssContentSize ?? {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
    return { x: 0, y: 0, width: size.width, height: Math.min(size.height, pageLimit) };
  }
  return {
    x: viewport.pageX + Math.max(0, region.x),
    y: viewport.pageY + Math.max(0, region.y),
    width: Math.max(1, region.width),
    height: Math.max(1, region.height),
  };
}

/** Keep model images within 1536 pixels without resizing the page or its layout. */
export async function modelScreenshot(
  cdp: BrowserCdp,
  region: CaptureRegion = { kind: "viewport" },
): Promise<Buffer> {
  const clip = await captureClip(cdp, region);
  const density = Density.parse(
    await cdp.send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    }),
  ).result.value;
  const geometry = modelImageGeometry(clip.width, clip.height);
  const scale = geometry.scale / density;
  const result = z.object({ data: z.string().max(768 * 1024) }).parse(
    await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      captureBeyondViewport: region.kind !== "viewport",
      clip: { ...clip, scale },
    }),
  );
  return Buffer.from(result.data, "base64");
}
