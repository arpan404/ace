/*
 * Which of a message's files the phone draws as a picture, and when it reads the original to do
 * it. iOS decodes every raster image type (HEIC, HEIF, PNG, JPEG, GIF, WebP, TIFF, BMP), so
 * anything typed `image/*` is a picture, as is a file named `.heic` or `.heif` whose type was lost
 * on the way. SVG is a document, not a raster, and stays a file. Pure: no I/O.
 */

const pictureNames = /\.(heic|heif)$/i;
const heicTypes = new Set(["image/heic", "image/heif"]);

/** The most of a HEIC original the phone reads to draw it when the daemon has no preview. */
export const heicOriginalLimit = 5 * 1024 * 1024;

export function drawnAsPicture(file: { mimeType: string; name: string }): boolean {
  const type = file.mimeType.toLowerCase();
  if (type === "image/svg+xml") return false;
  return type.startsWith("image/") || pictureNames.test(file.name);
}

/**
 * Whether a picture the daemon has no preview of is drawn from its original: a HEIC (stored
 * before the daemon previewed HEIC, or that its decoder can't read) small enough to fetch whole.
 */
export function originalStandsIn(file: { mimeType: string; name: string; bytes: number }): boolean {
  const heic = heicTypes.has(file.mimeType.toLowerCase()) || pictureNames.test(file.name);
  return heic && file.bytes <= heicOriginalLimit;
}

/**
 * Whether a picture whose preview the daemon refused (it advertises previews its decoder can't
 * make, as one without ace-media does) is drawn from its original: any picture small enough to
 * read whole for a tile. The phone downsamples it as it decodes.
 */
export function originalDrawsIn(file: { mimeType: string; name: string; bytes: number }): boolean {
  return drawnAsPicture(file) && file.bytes <= heicOriginalLimit;
}

/** The most of one file the phone fetches to open it (the SDK's own ceiling): past it, a file
 * shows as a row that doesn't open, never as one that fails when tapped. */
export const originalOpenLimit = 32 * 1024 * 1024;

/** The most of a picture the phone draws inline; a larger one is a file the person opens. */
export const pictureInlineLimit = 8 * 1024 * 1024;

/**
 * How a message's file shows: its `kind` for the icon (`image` for any picture), and whether it
 * is `drawn` as a picture, from the daemon's preview or a small HEIC's original. A picture past
 * `pictureInlineLimit` is never drawn, since its viewer would read it whole.
 */
export function pictureLine(file: {
  mimeType: string;
  name: string;
  bytes: number;
  kind?: string | undefined;
  thumbnailAvailable?: boolean | undefined;
}): { kind: string; drawn: boolean } {
  if (!drawnAsPicture(file)) return { kind: file.kind ?? "binary", drawn: false };
  const readable = file.thumbnailAvailable === true || originalStandsIn(file);
  return { kind: "image", drawn: readable && file.bytes <= pictureInlineLimit };
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));
const heifBrands = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "heif",
]);

/**
 * Whether `bytes` begin as a picture the phone decodes: PNG, JPEG, GIF, WebP, HEIC or HEIF,
 * TIFF or BMP. Anything else (an SVG named `.heic`, a video) is never handed to the decoder,
 * whatever its type or name says.
 */
export function pictureBytes(bytes: Uint8Array): boolean {
  const starts = (...head: number[]) => head.every((byte, at) => bytes[at] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true;
  if (starts(0xff, 0xd8, 0xff)) return true;
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return true;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return true;
  if (ascii(bytes, 4, 8) === "ftyp" && heifBrands.has(ascii(bytes, 8, 12))) return true;
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return true;
  return bytes.length >= 14 && starts(0x42, 0x4d);
}
