import type { MarketProblem } from "@ace/protocol/marketplace";

/*
 * Publisher pictures (ADR 0174 §3): avatars and listing pictures. The Worker can't decode pixels,
 * so it validates and strips the container instead: PNG chunks with their CRCs, JPEG segments,
 * WebP RIFF chunks. Only the image's own chunks are kept; text, EXIF, XMP, ICC profiles, data
 * after the end marker and animation are dropped, and the declared dimensions are checked. Pure:
 * bytes in, stripped bytes or a problem out.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export type ImageUse = "avatar" | "preview";

export interface ImageRules {
  maxBytes: number;
  minSide: number;
  maxSide: number;
  /** The longer side over the shorter, at most. */
  maxAspect: number;
}

const KiB = 1024;
export const imageRules: Readonly<Record<ImageUse, ImageRules>> = {
  avatar: { maxBytes: 512 * KiB, minSide: 64, maxSide: 1024, maxAspect: 2 },
  preview: { maxBytes: 1024 * KiB, minSide: 320, maxSide: 4096, maxAspect: 2 },
};

export interface StrippedImage {
  bytes: Uint8Array;
  type: ImageType;
  width: number;
  height: number;
}

class ImageProblem extends Error {}
const fail = (message: string): never => {
  throw new ImageProblem(message);
};

/** Validates `bytes` as a picture for `use` and returns it stripped, or the problem with it. */
export function stripImage(
  bytes: Uint8Array,
  use: ImageUse,
): StrippedImage | { problem: MarketProblem } {
  const rules = imageRules[use];
  try {
    if (bytes.byteLength > rules.maxBytes)
      fail(`A picture here is at most ${Math.round(rules.maxBytes / KiB)} KB.`);
    const image = parse(bytes);
    const { width, height } = image;
    if (Math.min(width, height) < rules.minSide || Math.max(width, height) > rules.maxSide)
      fail(`A picture here is ${rules.minSide} to ${rules.maxSide} pixels a side.`);
    if (Math.max(width, height) > rules.maxAspect * Math.min(width, height))
      fail(`A picture here is at most ${rules.maxAspect}:1.`);
    return image;
  } catch (error) {
    if (error instanceof ImageProblem) return { problem: { message: error.message } };
    throw error;
  }
}

function parse(bytes: Uint8Array): StrippedImage {
  if (startsWith(bytes, pngSignature)) return stripPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return stripJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return stripWebp(bytes);
  return fail("A picture is a PNG, JPEG or WebP file.");
}

/* ---------------------------------------------------------------- helpers */

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((value, index) => bytes[index] === value);

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = "";
  for (let index = at; index < at + length && index < bytes.length; index++)
    text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

const u32be = (b: Uint8Array, at: number) =>
  (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>>
  0;
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32le = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>>
  0;
const u24le = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/* ---------------------------------------------------------------- PNG */

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Chunks that are the image itself; everything else (text, EXIF, ICC, APNG frames) is dropped. */
const pngKept = new Set(["IHDR", "PLTE", "tRNS", "sRGB", "gAMA", "cHRM", "IDAT", "IEND"]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stripPng(bytes: Uint8Array): StrippedImage {
  const kept: Uint8Array[] = [Uint8Array.from(pngSignature)];
  let at: number = pngSignature.length;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let idatEnded = false;
  let ended = false;
  let first = true;
  while (!ended) {
    if (at + 12 > bytes.length) fail("The PNG ends before its IEND chunk.");
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) fail("A PNG chunk runs past the file's end.");
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32be(bytes, at + 8 + length))
      fail(`The PNG's ${type} chunk is damaged (its CRC doesn't match).`);
    if (first) {
      if (type !== "IHDR" || length !== 13) fail("A PNG starts with its IHDR chunk.");
      width = u32be(bytes, at + 8);
      height = u32be(bytes, at + 12);
      first = false;
    } else if (type === "IHDR") fail("The PNG has more than one IHDR chunk.");
    if (type === "IDAT") {
      if (idatEnded) fail("The PNG's image data is split by other chunks.");
      sawIdat = true;
    } else if (sawIdat) idatEnded = true;
    if (type === "IEND") ended = true;
    if (pngKept.has(type)) kept.push(bytes.subarray(at, end));
    else if (/^[A-Z]/.test(type) && type !== "IEND")
      fail(`The PNG has a critical chunk (${type.replace(/[^A-Za-z]/g, "?")}) a picture can't.`);
    at = end;
  }
  if (!sawIdat) fail("The PNG holds no image data.");
  // Anything after IEND is dropped with the rest.
  return { bytes: concat(kept), type: "image/png", width, height };
}

/* ---------------------------------------------------------------- JPEG */

/**
 * Segments that are the image itself: frames, tables, restart interval, scans, and Adobe's
 * APP14 (it names the colour transform). APP0 to APP13, APP15 (EXIF, XMP, ICC, thumbnails) and
 * comments are dropped.
 */
function jpegKept(marker: number): boolean {
  if (marker >= 0xc0 && marker <= 0xcf) return true; // SOFn, DHT, JPG, DAC
  return marker === 0xdb || marker === 0xdd || marker === 0xee;
}
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function stripJpeg(bytes: Uint8Array): StrippedImage {
  const kept: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let at = 2;
  let width = 0;
  let height = 0;
  let frames = 0;
  let scanned = false;
  for (;;) {
    if (at + 2 > bytes.length) fail("The JPEG ends before its end marker.");
    if (bytes[at] !== 0xff) fail("The JPEG's segments are out of step.");
    let marker = bytes[at + 1] ?? 0;
    while (marker === 0xff) {
      at += 1;
      marker = bytes[at + 1] ?? 0;
    }
    if (marker === 0xd9) {
      if (!scanned || frames === 0) fail("The JPEG holds no image data.");
      kept.push(Uint8Array.of(0xff, 0xd9));
      break; // Anything after the end marker is dropped.
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      fail("The JPEG has a marker out of place.");
    if (at + 4 > bytes.length) fail("A JPEG segment runs past the file's end.");
    const length = u16be(bytes, at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) fail("A JPEG segment runs past the file's end.");
    if (isFrame(marker)) {
      frames += 1;
      if (frames > 1) fail("The JPEG holds more than one frame.");
      height = u16be(bytes, at + 5);
      width = u16be(bytes, at + 7);
    }
    if (marker === 0xda) {
      if (frames === 0) fail("The JPEG's scan comes before its frame.");
      // The scan's entropy-coded data runs to the next marker that isn't a stuffed byte or a
      // restart.
      let data = end;
      while (data + 1 < bytes.length) {
        if (bytes[data] === 0xff) {
          const next = bytes[data + 1] ?? 0;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        data += 1;
      }
      if (data + 1 >= bytes.length) fail("The JPEG ends inside its image data.");
      kept.push(bytes.subarray(at, data));
      scanned = true;
      at = data;
      continue;
    }
    if (jpegKept(marker)) kept.push(bytes.subarray(at, end));
    at = end;
  }
  return { bytes: concat(kept), type: "image/jpeg", width, height };
}

/* ---------------------------------------------------------------- WebP */

interface RiffChunk {
  id: string;
  data: Uint8Array;
}

function riffChunk(id: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  for (let index = 0; index < 4; index++) header[index] = id.charCodeAt(index);
  new DataView(header.buffer).setUint32(4, data.byteLength, true);
  const pad = data.byteLength % 2 === 1 ? [Uint8Array.of(0)] : [];
  return concat([header, data, ...pad]);
}

function vp8Size(data: Uint8Array): { width: number; height: number } {
  if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a)
    fail("The WebP's lossy image data is damaged.");
  return { width: u16le(data, 6) & 0x3fff, height: u16le(data, 8) & 0x3fff };
}
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);

function vp8lSize(data: Uint8Array): { width: number; height: number } {
  if (data.length < 5 || data[0] !== 0x2f) fail("The WebP's lossless image data is damaged.");
  const bits = u32le(data, 1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function stripWebp(bytes: Uint8Array): StrippedImage {
  const declared = u32le(bytes, 4);
  if (declared + 8 > bytes.length || declared < 4) fail("The WebP's RIFF size is wrong.");
  const chunks: RiffChunk[] = [];
  let at = 12;
  // Anything past the RIFF's own size is dropped.
  const end = 8 + declared;
  while (at < end) {
    if (at + 8 > end) fail("A WebP chunk runs past the file's end.");
    const id = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    if (at + 8 + size > end) fail("A WebP chunk runs past the file's end.");
    chunks.push({ id, data: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);
  }
  const find = (id: string) => chunks.find((chunk) => chunk.id === id);
  if (find("ANIM") || find("ANMF")) fail("An animated WebP can't be a picture here.");
  const lossy = find("VP8 ");
  const lossless = find("VP8L");
  const image = lossy ?? lossless;
  if (!image || (lossy && lossless)) fail("The WebP holds no single image.");
  const imageChunk = image as RiffChunk;
  const size = lossy ? vp8Size(imageChunk.data) : vp8lSize(imageChunk.data);
  const extended = find("VP8X");
  if (extended) {
    if (extended.data.length < 10) fail("The WebP's VP8X chunk is damaged.");
    const canvas = {
      width: u24le(extended.data, 4) + 1,
      height: u24le(extended.data, 7) + 1,
    };
    if (canvas.width !== size.width || canvas.height !== size.height)
      fail("The WebP's canvas and image sizes differ.");
  }
  const alpha = lossy ? find("ALPH") : undefined;
  const parts: Uint8Array[] = [];
  if (alpha) {
    // Lossy with alpha needs the extended header; only the alpha flag is kept.
    const header = new Uint8Array(10);
    header[0] = 0x10;
    const w = size.width - 1;
    const h = size.height - 1;
    header.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 4);
    header.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 7);
    parts.push(riffChunk("VP8X", header), riffChunk("ALPH", alpha.data));
  }
  parts.push(riffChunk(imageChunk.id, imageChunk.data));
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(head.buffer).setUint32(4, body.byteLength + 4, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concat([head, body]), type: "image/webp", ...size };
}
