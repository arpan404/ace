import sharp from "sharp";
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
  size: { width: number; height: number },
  pieces: Parameters<BodyPainter>[1],
  perUnit: number,
): Promise<string | undefined> {
  const width = Math.max(1, Math.round(size.width * perUnit));
  const height = Math.max(1, Math.round(size.height * perUnit));
  const layers = await Promise.all(
    pieces.map(async ({ art, rect }) => {
      const left = Math.round(rect.x * perUnit);
      const top = Math.round(rect.y * perUnit);
      const w = Math.round((rect.x + rect.width) * perUnit) - left;
      const h = Math.round((rect.y + rect.height) * perUnit) - top;
      if (w <= 0 || h <= 0) return undefined;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"${stretchedArt(art, w, h).slice("<svg".length)}`;
      const input = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
      // A piece reaching past the body (none should) is cut to it.
      const cut = {
        left: Math.max(0, -left),
        top: Math.max(0, -top),
        width: Math.min(w, width - left) - Math.max(0, -left),
        height: Math.min(h, height - top) - Math.max(0, -top),
      };
      if (cut.width <= 0 || cut.height <= 0) return undefined;
      const fits = cut.left === 0 && cut.top === 0 && cut.width === w && cut.height === h;
      return {
        input: fits ? input : await sharp(input).extract(cut).toBuffer(),
        left: Math.max(0, left),
        top: Math.max(0, top),
      };
    }),
  );
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers.filter((layer) => layer !== undefined))
    .png({ compressionLevel: 9 })
    .toBuffer();
  const url = `data:image/png;base64,${png.toString("base64")}`;
  return url.length < urlLimit ? url : undefined;
}

/** Paints the pieces as PNG, as sharp as fits; undefined when they can't be drawn. */
export const pngBody: BodyPainter = async (size, pieces) => {
  const largest = Math.min(mostPerUnit, longestSide / Math.max(size.width, size.height, 1));
  for (const perUnit of [largest, largest / 2]) {
    const url = await paintAt(size, pieces, perUnit).catch(() => undefined);
    if (url) return url;
  }
  return undefined;
};
