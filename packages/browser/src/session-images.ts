import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendPage } from "./backend.ts";
import { modelScreenshot, type CaptureRegion } from "./model-screenshot.ts";
import { screenshotPlacement, type ScreenshotGeometry } from "./screenshot-geometry.ts";

/** A model screenshot, with where its pixels lie on the page when that could be read. */
export interface AgentScreenshot {
  bytes: Uint8Array;
  geometry?: ScreenshotGeometry | undefined;
}

const ScreenshotBytes = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= 8 * 1024 * 1024, "Browser screenshot exceeds image limit");
/**
 * A screenshot of one tab, taken from that tab's own page: the tab the person is viewing never
 * changes. Its bytes are released only while its submitted read fences still hold.
 */
export async function agentScreenshot(
  page: BrowserBackendPage,
  region: () => Promise<CaptureRegion>,
  fences: {
    read(): void;
    ready(): void;
    generation(): number;
    lost(): boolean;
    paused(): boolean;
  },
  signal?: AbortSignal,
): Promise<AgentScreenshot> {
  signal?.throwIfAborted();
  fences.read();
  fences.ready();
  const area = await region();
  fences.read();
  const generation = fences.generation();
  // Geometry is a convenience: a page that cannot report its layout still gets its image.
  const placement = await screenshotPlacement(page.cdp, area).catch(() => undefined);
  const bytes =
    area.kind === "viewport"
      ? await page.screenshot("jpeg")
      : await modelScreenshot(page.cdp, area);
  signal?.throwIfAborted();
  fences.read();
  if (fences.paused()) throw new BrowserActionError("backend_changed");
  fences.ready();
  if (generation !== fences.generation() && fences.lost())
    throw new BrowserActionError("backend_changed");
  const checked = ScreenshotBytes.parse(bytes);
  return { bytes: checked, geometry: placement?.measure(checked) };
}
