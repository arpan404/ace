/*
 * Recognising safe, inert data (ADR 0174 §8, finding 1). A file the scanner can't decode as text
 * is safe only when its bytes are a data format ace knows carries no code — an image, a font, an
 * audio or video container. Anything else undecodable is an unknown binary, held for review: the
 * scanner never infers safety from unrecognised magic. Pure.
 */

type Magic = { at: number; bytes: number[] };
const at0 = (...bytes: number[]): Magic => ({ at: 0, bytes });

/** The leading bytes of data formats ace treats as inert. */
const SAFE_MAGIC: readonly Magic[] = [
  at0(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), // PNG
  at0(0xff, 0xd8, 0xff), // JPEG
  at0(0x47, 0x49, 0x46, 0x38), // GIF
  at0(0x42, 0x4d), // BMP
  at0(0x00, 0x00, 0x01, 0x00), // ICO
  at0(0x00, 0x00, 0x02, 0x00), // CUR
  at0(0x77, 0x4f, 0x46, 0x46), // woff
  at0(0x77, 0x4f, 0x46, 0x32), // woff2
  at0(0x00, 0x01, 0x00, 0x00), // ttf / otf outline
  at0(0x4f, 0x54, 0x54, 0x4f), // OTTO (otf)
  at0(0x74, 0x74, 0x63, 0x66), // ttcf (font collection)
  at0(0x74, 0x72, 0x75, 0x65), // true (TrueType)
  at0(0x1a, 0x45, 0xdf, 0xa3), // Matroska / WebM
  at0(0x4f, 0x67, 0x67, 0x53), // Ogg
  at0(0x49, 0x44, 0x33), // MP3 (ID3)
  at0(0xff, 0xfb), // MP3 frame
  at0(0xff, 0xf3),
  at0(0xff, 0xf2),
];

/** RIFF containers whose form tag names a safe format (WebP, WAV, AVI). */
const RIFF_FORMS = new Set(["WEBP", "WAVE", "AVI "]);
/** ISO base-media (`ftyp`) brands ace treats as inert (image and A/V). */
const FTYP_BRANDS = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "mif1",
  "msf1",
  "mp41",
  "mp42",
  "isom",
  "iso2",
  "m4a ",
  "m4v ",
  "qt  ",
  "3gp4",
  "3gp5",
]);

const starts = (bytes: Uint8Array, magic: Magic): boolean => {
  if (bytes.length < magic.at + magic.bytes.length) return false;
  for (let index = 0; index < magic.bytes.length; index++)
    if (bytes[magic.at + index] !== magic.bytes[index]) return false;
  return true;
};

const tag = (bytes: Uint8Array, at: number): string =>
  bytes.length < at + 4
    ? ""
    : String.fromCharCode(
        bytes[at] ?? 0,
        bytes[at + 1] ?? 0,
        bytes[at + 2] ?? 0,
        bytes[at + 3] ?? 0,
      );

/**
 * Whether `bytes` are a data format ace knows is inert. `path` is advisory only; the decision is
 * on the bytes. An empty file is inert. Anything unrecognised is not safe (held, not passed).
 */
export function safeBinary(bytes: Uint8Array, path?: string): boolean {
  void path;
  if (bytes.length === 0) return true;
  if (SAFE_MAGIC.some((magic) => starts(bytes, magic))) return true;
  // RIFF <size> FORM
  if (tag(bytes, 0) === "RIFF" && RIFF_FORMS.has(tag(bytes, 8))) return true;
  // ISO base media: <size> 'ftyp' <brand>
  if (tag(bytes, 4) === "ftyp" && FTYP_BRANDS.has(tag(bytes, 8).toLowerCase())) return true;
  return false;
}
