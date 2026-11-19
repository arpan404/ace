import sharp from "sharp";
import { expect, test } from "vitest";
import { pdfArt } from "./pdf-svg.ts";
import { pngBody } from "./simulator-body-png.ts";
import { bodyLayout } from "./simulator-body.ts";
import { tinyPdf } from "./testing/tiny-pdf.ts";

/**
 * A piece drawn as Apple draws them: a grey layer filling it, black glass over that, both
 * reaching the piece's edges.
 */
function layered(width: number, height: number, prefix: string) {
  const art = pdfArt(
    tinyPdf(
      width,
      height,
      `0.5 0.5 0.5 rg 0 0 ${width} ${height} re f 0 0 0 rg 0 0 ${width} ${height} re f`,
    ),
    prefix,
  );
  if (!art) throw new Error("test art didn't parse");
  return art;
}

test("a body built from pieces paints as one picture, with no grey where pieces meet", async () => {
  const corner = (prefix: string) => layered(20, 20, prefix);
  const pieces = bodyLayout(
    {
      topLeft: corner("a"),
      topRight: corner("b"),
      bottomLeft: corner("c"),
      bottomRight: corner("d"),
      top: layered(2, 20, "e"),
      bottom: layered(2, 20, "f"),
      left: layered(20, 2, "g"),
      right: layered(20, 2, "h"),
    },
    // A size whose joins fall between pixels at any scale it is drawn at.
    93.37,
    171.61,
  );

  const url = await pngBody({ width: 93.37, height: 171.61 }, pieces);

  expect(url).toMatch(/^data:image\/png;base64,/);
  const { data, info } = await sharp(Buffer.from(url?.split(",")[1] ?? "", "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Every pixel of the bezel ring is the glass's black: no hairline of the grey beneath.
  let brightest = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const inRing =
        x < 20 * (info.width / 93.37) ||
        y < 20 * (info.height / 171.61) ||
        x >= info.width - 20 * (info.width / 93.37) ||
        y >= info.height - 20 * (info.height / 171.61);
      if (!inRing) continue;
      const at = (y * info.width + x) * info.channels;
      brightest = Math.max(brightest, data[at] ?? 0);
    }
  expect(brightest).toBeLessThan(8);
});
