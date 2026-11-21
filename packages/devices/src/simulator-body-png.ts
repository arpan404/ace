import type { ImageLayer } from "@ace/media/image-wire";
import { lookDeadlineMs, type ImageWork } from "./device-images.ts";
import type { BodyPainter } from "./simulator-body.ts";
import { stretchedArt } from "./simulator-body.ts";

/*
 * A body built from pieces, painted as one PNG. Apple's pieces are layers (grey metal under
 * black glass) that all end at the piece's edge; drawn as SVG at an arbitrary scale, an edge
 * that falls between pixels lets the grey show as a hairline where two pieces meet. Here each
 * piece is drawn on its own at a whole number of pixels and laid edge to edge, so every join
 * lands on a pixel boundary and the body reads as one piece of hardware.
 */

/** Pixels per body unit at most (a phone's points at 3×), and the longest side in pixels. */
const mostPerUnit = 3;
const longestSide = 2400;
/** A data URL this long or longer travels badly in one message; draw smaller instead. */
const urlLimit = 900_000;

async function paintAt(
  images: ImageWork,
  size: { width: number; height: number },
  pieces: Parameters<BodyPainter>[1],
  perUnit: number,
): Promise<string | undefined> {
  const width = Math.max(1, Math.round(size.width * perUnit));
  const height = Math.max(1, Math.round(size.height * perUnit));
  const inputs: { kind: "bytes"; bytes: Uint8Array }[] = [];
  const layers: ImageLayer[] = [];
  for (const { art, rect } of pieces) {
    const left = Math.round(rect.x * perUnit);
    const top = Math.round(rect.y * perUnit);
    const w = Math.round((rect.x + rect.width) * perUnit) - left;
    const h = Math.round((rect.y + rect.height) * perUnit) - top;
    if (w <= 0 || h <= 0) continue;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"${stretchedArt(art, w, h).slice("<svg".length)}`;
    // Each piece drawn on its own at whole pixels; a piece reaching past the body (none should)
    // is cut to it by the canvas.
    layers.push({
      kind: "image",
      input: inputs.length,
      left,
      top,
      width: w,
      height: h,
      fit: "fill",
    });
    inputs.push({ kind: "bytes", bytes: Buffer.from(svg, "utf8") });
  }
  const png = await images.run({
    inputs,
    op: {
      op: "compose",
      width,
      height,
      background: [0, 0, 0, 0],
      maxPixels: width * height,
      layers,
      output: { format: "png" },
    },
    deadlineMs: lookDeadlineMs,
  });
  const url = `data:image/png;base64,${Buffer.from(png.bytes).toString("base64")}`;
  return url.length < urlLimit ? url : undefined;
}

/** Paints the pieces as PNG through ace-media, as crisp as fits; undefined when they can't be drawn. */
export function pngBody(images: ImageWork): BodyPainter {
  return async (size, pieces) => {
    const largest = Math.min(mostPerUnit, longestSide / Math.max(size.width, size.height, 1));
    for (const perUnit of [largest, largest / 2]) {
      const url = await paintAt(images, size, pieces, perUnit).catch(() => undefined);
      if (url) return url;
    }
    return undefined;
  };
}
