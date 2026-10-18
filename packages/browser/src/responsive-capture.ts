import { modelImageGeometry } from "@ace/mcp-server";
import type { BrowserScreenshotSize } from "@ace/protocol";
import { z } from "zod";
import type { BrowserBackendPage, BrowserCdp } from "./backend.ts";
import { captureClip } from "./model-screenshot.ts";

/** The page sizes a multi-size screenshot lays the page out at (`BrowserScreenshotSize`). */
export const responsiveSizes: Record<
  BrowserScreenshotSize,
  { width: number; height: number; mobile: boolean }
> = {
  phone: { width: 390, height: 844, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
};

/** A device a person or agent set on a tab with `emulate`; restored after a multi-size capture. */
export interface TabEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

const Viewport = z.object({
  result: z.object({
    value: z.object({ width: z.number(), height: z.number(), scale: z.number().positive() }),
  }),
});
const Data = z.object({ data: z.string().max(64 * 1024 * 1024) });

/** The tab's viewport as its page sees it: CSS size and device pixel ratio. */
async function viewportOf(cdp: BrowserCdp) {
  return Viewport.parse(
    await cdp.send("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })",
      returnByValue: true,
    }),
  ).result.value;
}

/** Two frames, so the layout at the new size has painted before it is captured. */
async function painted(cdp: BrowserCdp): Promise<void> {
  await cdp.send("Runtime.evaluate", {
    expression:
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))",
    awaitPromise: true,
    returnByValue: true,
  });
}

export interface SizedCapture {
  size: BrowserScreenshotSize;
  width: number;
  height: number;
  /** Within the model image limits. */
  jpeg: Buffer;
  /** Full resolution, when asked for. */
  png?: Buffer | undefined;
}

/**
 * Lays the tab's page out at each size in turn (device metrics emulation, 1 device pixel per CSS
 * pixel, phone and tablet as mobile), captures it there, and puts the tab back as it was: the
 * device last set with `emulate`, else the backend's own size (cleared emulation, re-applied at
 * the old size when clearing alone doesn't bring it back). `check` runs before each step, so an
 * abort or a tab turned private stops the work, and the tab is restored all the same.
 */
export async function captureAtSizes(
  page: BrowserBackendPage,
  sizes: readonly BrowserScreenshotSize[],
  options: {
    fullPage: boolean;
    png: boolean;
    /** The device the tab emulates (`emulate`), put back afterwards; none: its own size. */
    emulation: TabEmulation | undefined;
    check(): void;
  },
): Promise<SizedCapture[]> {
  const cdp = page.cdp;
  options.check();
  const before = await viewportOf(cdp);
  const captures: SizedCapture[] = [];
  try {
    for (const size of new Set(sizes)) {
      options.check();
      const device = responsiveSizes[size];
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: device.width,
        height: device.height,
        deviceScaleFactor: 1,
        mobile: device.mobile,
      });
      await painted(cdp);
      options.check();
      const shot = await captureSize(cdp, device, options);
      captures.push({ size, ...shot });
    }
  } finally {
    await restore(page, before, options.emulation);
  }
  return captures;
}

/**
 * The page as a device of this size shows it: the screen (no clip), or with `fullPage` the
 * whole document scaled to the device's width, as a phone shows a page that isn't responsive.
 */
async function captureSize(
  cdp: BrowserCdp,
  device: { width: number; height: number },
  options: { fullPage: boolean; png: boolean },
): Promise<Omit<SizedCapture, "size">> {
  let width = device.width;
  let height = device.height;
  let clip: Record<string, number> | undefined;
  if (options.fullPage) {
    const page = await captureClip(cdp, { kind: "page" });
    const scale = device.width / page.width;
    width = device.width;
    height = Math.max(1, Math.round(page.height * scale));
    clip = { x: 0, y: 0, width: page.width, height: page.height, scale };
  }
  const geometry = clip ? modelImageGeometry(width, height) : { width };
  const shoot = async (format: "jpeg" | "png", scale: number) =>
    Buffer.from(
      Data.parse(
        await cdp.send("Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: 75 } : {}),
          captureBeyondViewport: options.fullPage,
          // Every device's screen is within the model's image limits as it is.
          ...(clip ? { clip: { ...clip, scale: (clip["scale"] ?? 1) * scale } } : {}),
        }),
      ).data,
      "base64",
    );
  return {
    width,
    height,
    jpeg: await shoot("jpeg", geometry.width / width),
    ...(options.png ? { png: await shoot("png", 1) } : {}),
  };
}

async function restore(
  page: BrowserBackendPage,
  before: { width: number; height: number; scale: number },
  emulated: TabEmulation | undefined,
): Promise<void> {
  const cdp = page.cdp;
  if (emulated) {
    const device = {
      width: emulated.width,
      height: emulated.height,
      deviceScaleFactor: emulated.deviceScaleFactor,
      mobile: emulated.mobile,
    };
    // A backend that sizes its own tabs (ace's Chrome, with its zoom) re-applies the device.
    if (page.emulate) await page.emulate(device);
    else await cdp.send("Emulation.setDeviceMetricsOverride", device);
    return;
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  const after = await viewportOf(cdp);
  if (
    after.width === before.width &&
    after.height === before.height &&
    after.scale === before.scale
  )
    return;
  // The backend sized the tab itself with an override (ace's Chrome does): put that size back.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: before.width,
    height: before.height,
    deviceScaleFactor: before.scale,
    mobile: false,
  });
}
