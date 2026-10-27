import { PublicToolError } from "@ace/mcp-server/errors";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Viewport = z.object({
  result: z.object({
    value: z.object({ width: z.number(), height: z.number(), scale: z.number().positive() }),
  }),
});

/** The tab's viewport as its page sees it: CSS size and device pixel ratio. */
export async function pageViewport(cdp: BrowserCdp) {
  return Viewport.parse(
    await cdp.send("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })",
      returnByValue: true,
    }),
  ).result.value;
}

/**
 * Two frames, so a layout at a new size has applied; a short timer stands in where frames
 * don't run (an unseen tab).
 */
export async function settled(cdp: BrowserCdp): Promise<void> {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const frame = () => new Promise((next) => {
        let fired = false;
        const go = () => { if (!fired) { fired = true; next(); } };
        requestAnimationFrame(go);
        setTimeout(go, 100);
      });
      return frame().then(frame).then(() => true);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
}

/**
 * Fails with `viewport_mismatch` unless the page lays out at `size` (CSS pixels at 100% zoom;
 * the tab's own `zoom` shrinks it, as browser zoom does). A pixel either way is rounding.
 */
export async function expectViewport(
  cdp: BrowserCdp,
  size: { width: number; height: number },
  zoom: number,
): Promise<void> {
  await settled(cdp);
  if (process.platform === "win32") await windowsApplied(cdp, size, zoom);
  const seen = await pageViewport(cdp);
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = size.width / factor;
  const height = size.height / factor;
  if (Math.abs(seen.width - width) <= 1 && Math.abs(seen.height - height) <= 1) return;
  throw new PublicToolError(
    "viewport_mismatch",
    undefined,
    undefined,
    undefined,
    `The page lays out at ${Math.round(seen.width)}×${Math.round(seen.height)} CSS pixels, not ${Math.round(width)}×${Math.round(height)}.`,
  );
}

/**
 * Windows: an unseen tab draws no frames, and on a slow machine its renderer can take longer than
 * `settled` to apply a new emulated size (measured on GitHub's Windows runners: still at the old
 * 1280 × 720 after both waits). Waits up to 2 s for the size to apply; the check that follows is
 * unchanged, so a size that never applies still fails.
 */
async function windowsApplied(
  cdp: BrowserCdp,
  size: { width: number; height: number },
  zoom: number,
): Promise<void> {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  for (const deadline = performance.now() + 2_000; performance.now() < deadline;) {
    const seen = await pageViewport(cdp);
    if (
      Math.abs(seen.width - size.width / factor) <= 1 &&
      Math.abs(seen.height - size.height / factor) <= 1
    )
      return windowsDrawn(cdp, seen, deadline);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Windows: layout takes the new size before the compositor draws it, and until then an unseen
 * tab's screenshots (what a recording of a background tab is made of) still show the old size.
 * Waits, within the same bound, for a screenshot of the new size; its width may lack a classic
 * scrollbar's.
 */
async function windowsDrawn(
  cdp: BrowserCdp,
  seen: { width: number; height: number; scale: number },
  deadline: number,
): Promise<void> {
  const { imageSize } = await import("./image-size.ts");
  const Shot = z.object({ data: z.string() });
  const want = { width: seen.width * seen.scale, height: seen.height * seen.scale };
  while (performance.now() < deadline) {
    const shot = Shot.safeParse(
      await cdp
        .send("Page.captureScreenshot", { format: "jpeg", quality: 10 })
        .catch(() => undefined),
    );
    if (!shot.success) return;
    const drawn = imageSize(Buffer.from(shot.data.data, "base64"));
    if (!drawn) return;
    if (
      Math.abs(drawn.width - want.width) <= 24 * seen.scale &&
      Math.abs(drawn.height - want.height) <= 1
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
