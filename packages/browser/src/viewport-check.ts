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

/** How long a page may take to lay out at a new size before the size counts as refused. */
const layoutWaitMs = 3_000;

/**
 * Whether the page lays out at `width`×`height` (a pixel either way is rounding), waiting for a
 * size just set to reach it. The size arrives asynchronously and an unseen tab runs no frames or
 * resize events, so the page checks its own size until it fits or the wait runs out.
 */
async function laysOutAt(cdp: BrowserCdp, width: number, height: number): Promise<boolean> {
  const reply = await cdp.send("Runtime.evaluate", {
    expression: `new Promise((done) => {
      const fits = () => Math.abs(innerWidth - ${width}) <= 1 && Math.abs(innerHeight - ${height}) <= 1;
      if (fits()) return done(true);
      const poll = setInterval(() => { if (fits()) { clearInterval(poll); clearTimeout(stop); done(true); } }, 25);
      const stop = setTimeout(() => { clearInterval(poll); done(fits()); }, ${layoutWaitMs});
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  return (
    z.object({ result: z.object({ value: z.boolean() }) }).safeParse(reply).data?.result.value ===
    true
  );
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
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = size.width / factor;
  const height = size.height / factor;
  if (await laysOutAt(cdp, width, height)) return;
  const seen = await pageViewport(cdp);
  throw new PublicToolError(
    "viewport_mismatch",
    undefined,
    undefined,
    undefined,
    `The page lays out at ${Math.round(seen.width)}×${Math.round(seen.height)} CSS pixels, not ${Math.round(width)}×${Math.round(height)}.`,
  );
}
