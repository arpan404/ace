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
