import type { IconImages } from "./icon-image.ts";

/*
 * A downloaded favicon (ICO, PNG, SVG, GIF, JPEG or WebP) as one PNG of at most 64px. ICO files
 * hold several sizes: ace-media draws the largest one up to 64px, whether it is an embedded PNG
 * or a 24/32-bit Windows bitmap. Older palette bitmaps are left out.
 */

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

function ico(bytes: Buffer): boolean {
  return bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1;
}

/**
 * The favicon as a PNG. Null when it is not an image ace will show; undefined when decoding
 * could not run now (a busy or missing decoder).
 */
export async function faviconPng(
  bytes: Buffer,
  icons: IconImages,
): Promise<Buffer | null | undefined> {
  if (looksLikeSvg(bytes)) return icons.rasterPng(bytes, true);
  // A site that answers with a page, not an image, has no favicon there.
  return ico(bytes) || raster(bytes) ? icons.rasterPng(bytes) : null;
}

function raster(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 8).equals(pngMagic) ||
    bytes.subarray(0, 4).toString("latin1") === "GIF8" ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP")
  );
}
