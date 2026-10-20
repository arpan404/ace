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
