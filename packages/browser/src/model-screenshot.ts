import { modelImageGeometry } from "@ace/mcp-server";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { BrowserActionError } from "./action-error.ts";

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

/**
 * Where a region lies in page coordinates (`clip`; element rects are viewport-relative), and
 * how far the viewport is scrolled (`scroll`), so page points can be told as viewport points.
 */
export async function captureArea(cdp: BrowserCdp, region: CaptureRegion) {
  const metrics = Metrics.parse(await cdp.send("Page.getLayoutMetrics"));
  const viewport = metrics.cssVisualViewport;
  const scroll = { x: viewport.pageX, y: viewport.pageY };
  if (region.kind === "viewport")
    return {
      scroll,
      clip: { ...scroll, width: viewport.clientWidth, height: viewport.clientHeight },
    };
  if (region.kind === "page") {
    const size = metrics.cssContentSize ?? {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
    return {
      scroll,
      clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, pageLimit) },
    };
  }
  return {
    scroll,
    clip: {
      x: viewport.pageX + Math.max(0, region.x),
      y: viewport.pageY + Math.max(0, region.y),
      width: Math.max(1, region.width),
      height: Math.max(1, region.height),
    },
  };
}
export async function captureClip(cdp: BrowserCdp, region: CaptureRegion) {
  return (await captureArea(cdp, region)).clip;
}

/** The largest JPEG a model screenshot may be, base64-encoded. */
const modelImageLimit = 768 * 1024;
/** Quality, then size, steps for a page whose JPEG is too large (dense text, photos, noise). */
const attempts = [
  { quality: 70, shrink: 1 },
  { quality: 50, shrink: 1 },
  { quality: 50, shrink: 0.75 },
  { quality: 40, shrink: 0.5 },
  { quality: 30, shrink: 0.35 },
] as const;

/**
 * Keep model images within 1536 pixels and the model's byte budget without resizing the page or
 * its layout: a capture over the budget is taken again at lower quality, then smaller.
 */
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
  for (const attempt of attempts) {
    const { data } = z.object({ data: z.string().max(64 * 1024 * 1024) }).parse(
      await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: attempt.quality,
        captureBeyondViewport: region.kind !== "viewport",
        clip: { ...clip, scale: (geometry.scale * attempt.shrink) / density },
      }),
    );
    if (data.length <= modelImageLimit) return Buffer.from(data, "base64");
  }
  throw new BrowserActionError("limit");
}
