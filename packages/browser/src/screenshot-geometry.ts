import type { BrowserCdp } from "./backend.ts";
import { imageSize } from "./image-size.ts";
import { captureArea, type CaptureRegion } from "./model-screenshot.ts";

/**
 * How an agent screenshot maps onto the page: the image's size in pixels, the CSS pixels each
 * image pixel covers (`scale`), and the viewport point of its top-left corner (`origin`). A point
 * (px, py) in the image is the viewport point (origin.x + px * scale, origin.y + py * scale),
 * which is what click x, y takes.
 */
export interface ScreenshotGeometry {
  width: number;
  height: number;
  scale: number;
  origin: { x: number; y: number };
}

/** Reads where `region` lies before the capture; `measure` then fits it to the image taken. */
export async function screenshotPlacement(cdp: BrowserCdp, region: CaptureRegion) {
  const { clip, scroll } = await captureArea(cdp, region);
  return {
    measure(bytes: Uint8Array): ScreenshotGeometry | undefined {
      const size = imageSize(bytes);
      if (!size || size.width <= 0) return undefined;
      return {
        width: size.width,
        height: size.height,
        scale: Math.round((clip.width / size.width) * 10_000) / 10_000,
        origin: { x: hundredths(clip.x - scroll.x), y: hundredths(clip.y - scroll.y) },
      };
    },
  };
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
