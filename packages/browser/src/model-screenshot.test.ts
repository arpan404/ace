import { expect, it } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import { modelScreenshot } from "./model-screenshot.ts";
import { z } from "zod";

const Clip = z.object({ width: z.number(), height: z.number(), scale: z.number() });

/**
 * A zoomed page as Chromium shows it (measured in Electron at zoom 1.316): layout metrics in
 * CSS pixels, a capture clip read in DIPs, and an image of clip × scale × the screen's scale.
 * Each capture records the part of the page (CSS pixels) it shows and its image size.
 */
function zoomedPage(zoom: number, screenScale: number) {
  const viewport = { width: 1440, height: 900 };
  const shots: { shows: { width: number; height: number }; image: { width: number } }[] = [];
  const cdp: BrowserCdp = {
    async send(method, params) {
      if (method === "Page.getLayoutMetrics")
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: viewport.width,
            clientHeight: viewport.height,
            zoom,
          },
        };
      if (method === "Runtime.evaluate") return { result: { value: screenScale * zoom } };
      if (method === "Page.captureScreenshot") {
        const clip = Clip.parse(params?.["clip"]);
        shots.push({
          shows: { width: clip.width / zoom, height: clip.height / zoom },
          image: { width: Math.round(clip.width * clip.scale * screenScale) },
        });
        return { data: "AA==" };
      }
      return {};
    },
    on() {},
    off() {},
  };
  return { cdp, viewport, shots };
}

it("a zoomed page's screenshot shows its whole viewport, not its top-left part", async () => {
  const page = zoomedPage(1.316, 2);
  await modelScreenshot(page.cdp);
  const [shot] = page.shots;
  expect(shot?.shows.width).toBeCloseTo(page.viewport.width, 6);
  expect(shot?.shows.height).toBeCloseTo(page.viewport.height, 6);
  // One image pixel per CSS pixel, as on an unzoomed page.
  expect(shot?.image.width).toBe(page.viewport.width);
});

it("an unzoomed page's screenshot is unchanged", async () => {
  const page = zoomedPage(1, 2);
  await modelScreenshot(page.cdp);
  expect(page.shots[0]).toEqual({ shows: page.viewport, image: { width: page.viewport.width } });
});
