import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { BrowserBackendPage } from "./backend.ts";
import { captureClip, type CaptureRegion } from "./model-screenshot.ts";
import type { SnapshotRefs } from "./refs.ts";

const Data = z.object({ data: z.string().max(64 * 1024 * 1024) });

/** The area a screenshot command asks for: one element, the whole page or the viewport. */
export async function screenshotRegion(
  options: { fullPage?: boolean | undefined; ref?: string | undefined },
  refs: SnapshotRefs,
  beforeDispatch: () => void,
): Promise<CaptureRegion> {
  if (options.ref) return { kind: "element", ...(await refs.bounds(options.ref, beforeDispatch)) };
  return options.fullPage ? { kind: "page" } : { kind: "viewport" };
}

/** A full-resolution PNG of a region; the viewport goes through the backend's own capture. */
export async function pngScreenshot(page: BrowserBackendPage, region: CaptureRegion) {
  if (region.kind === "viewport") return page.screenshot("png");
  const clip = await captureClip(page.cdp, region);
  const { data } = Data.parse(
    await page.cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    }),
  );
  return Buffer.from(data, "base64");
}

/** Prints the page to a PDF file in the session directory. */
export async function printPdf(
  page: BrowserBackendPage,
  dir: string,
  name: string,
  options: { landscape: boolean; printBackground: boolean },
): Promise<{ path: string; mimeType: "application/pdf"; bytes: number }> {
  const { data } = Data.parse(
    await page.cdp.send("Page.printToPDF", {
      landscape: options.landscape,
      printBackground: options.printBackground,
    }),
  );
  const bytes = Buffer.from(data, "base64");
  const path = join(dir, `${name}.pdf`);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, mimeType: "application/pdf", bytes: bytes.byteLength };
}
