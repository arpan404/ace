import { rasterPng } from "./icon-image.ts";

/*
 * A downloaded favicon (ICO, PNG, SVG, GIF, JPEG or WebP) as one PNG of at most 64px. ICO files
 * hold several sizes: the largest one up to 64px is used, whether it is an embedded PNG or a
 * 24/32-bit Windows bitmap. Older palette bitmaps are left out.
 */

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface IconEntry {
  width: number;
  image: Buffer;
}

function icoEntries(bytes: Buffer): IconEntry[] | undefined {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1)
    return undefined;
  const count = bytes.readUInt16LE(4);
  if (count < 1 || count > 32 || bytes.length < 6 + 16 * count) return undefined;
  const entries: IconEntry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (length < 40 || offset < 6 + 16 * count || offset + length > bytes.length) continue;
    entries.push({ width: bytes[entry] || 256, image: bytes.subarray(offset, offset + length) });
  }
  // Largest first, but never past 64px when a smaller one exists.
  return entries.toSorted((a, b) => {
    const fitA = a.width <= 64 ? 1 : 0;
    const fitB = b.width <= 64 ? 1 : 0;
    return fitB - fitA || (fitA ? b.width - a.width : a.width - b.width);
  });
}

/** A 24 or 32-bit bottom-up DIB as top-down RGBA, or undefined for any other layout. */
function decodeBitmap(image: Buffer): { raw: Buffer; width: number; height: number } | undefined {
  if (image.length < 40 || image.readUInt32LE(0) !== 40) return undefined;
  const width = image.readInt32LE(4);
  const height = image.readInt32LE(8) / 2;
  const bits = image.readUInt16LE(14);
  if (width < 1 || width > 256 || height !== width || image.readUInt32LE(16) !== 0)
    return undefined;
  if (bits !== 32 && bits !== 24) return undefined;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const pixels = 40;
  const mask = pixels + stride * height;
  if (mask + (bits === 24 ? maskStride * height : 0) > image.length) return undefined;
  const raw = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + stride * (height - 1 - y);
    for (let x = 0; x < width; x++) {
      const from = row + x * (bits / 8);
      const to = (y * width + x) * 4;
      raw[to] = image[from + 2] ?? 0;
      raw[to + 1] = image[from + 1] ?? 0;
      raw[to + 2] = image[from] ?? 0;
      const alpha = bits === 32 ? (image[from + 3] ?? 0) : 255;
      raw[to + 3] = alpha;
      if (bits === 32 && alpha) anyAlpha = true;
    }
  }
  // 24-bit bitmaps (and 32-bit ones with an empty alpha channel) take transparency from the mask.
  if (bits === 24 || !anyAlpha) {
    if (mask + maskStride * height > image.length) return { raw, width, height };
    for (let y = 0; y < height; y++) {
      const row = mask + maskStride * (height - 1 - y);
      for (let x = 0; x < width; x++) {
        const transparent = ((image[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        raw[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { raw, width, height };
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * The favicon as a PNG. Null when it is not an image ace will show; undefined when decoding
 * could not run now (a busy or missing decoder).
 */
export async function faviconPng(bytes: Buffer): Promise<Buffer | null | undefined> {
  const entries = icoEntries(bytes);
  if (entries) {
    let unavailable = false;
    for (const entry of entries) {
      const png = entry.image.subarray(0, 8).equals(pngMagic)
        ? await rasterPng(entry.image)
        : await (async () => {
            const bitmap = decodeBitmap(entry.image);
            return bitmap ? rasterPng(bitmap) : null;
          })();
      if (png) return png;
      unavailable ||= png === undefined;
    }
    return unavailable ? undefined : null;
  }
  if (looksLikeSvg(bytes)) return rasterPng(bytes, true);
  // A site that answers with a page, not an image, has no favicon there.
  return raster(bytes) ? rasterPng(bytes) : null;
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
