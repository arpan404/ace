import { describe, expect, it } from "vitest";
import { stripImage } from "./image.ts";

/* Synthetic, inert pictures: containers with the right structure and placeholder pixel data. */

const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const be32 = (value: number) => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
const le32 = (value: number) => Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);

function crc(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array, damaged = false) {
  const body = concat(text(type), data);
  return concat(be32(data.length), body, be32(crc(body) ^ (damaged ? 1 : 0)));
}
const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ihdr = (width: number, height: number) =>
  chunk("IHDR", concat(be32(width), be32(height), Uint8Array.of(8, 6, 0, 0, 0)));
const idat = chunk("IDAT", Uint8Array.of(0x78, 0x9c, 1, 2, 3));
const iend = chunk("IEND", new Uint8Array());

function png(width: number, height: number, ...extra: Uint8Array[]) {
  return concat(signature, ihdr(width, height), ...extra, idat, iend);
}

const chunkTypes = (bytes: Uint8Array) => {
  const types: string[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
    types.push(new TextDecoder().decode(bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return types;
};

function jpeg(width: number, height: number, ...segments: Uint8Array[]) {
  const segment = (marker: number, data: Uint8Array) =>
    concat(Uint8Array.of(0xff, marker, (data.length + 2) >> 8, data.length + 2), data);
  const sof = segment(
    0xc0,
    Uint8Array.of(8, height >> 8, height, width >> 8, width, 1, 1, 0x11, 0),
  );
  return concat(
    Uint8Array.of(0xff, 0xd8),
    ...segments,
    segment(0xdb, new Uint8Array(65)),
    sof,
    segment(0xc4, new Uint8Array(20)),
    segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56),
    Uint8Array.of(0xff, 0xd9),
  );
}
const app = (marker: number, payload: string) => {
  const data = text(payload);
  return concat(Uint8Array.of(0xff, marker, (data.length + 2) >> 8, data.length + 2), data);
};

function riff(...chunks: Uint8Array[]) {
  const body = concat(text("WEBP"), ...chunks);
  return concat(text("RIFF"), le32(body.length), body);
}
const webpChunk = (id: string, data: Uint8Array) =>
  concat(text(id), le32(data.length), data, data.length % 2 ? Uint8Array.of(0) : new Uint8Array());
const vp8l = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14);
  return webpChunk("VP8L", concat(Uint8Array.of(0x2f), le32(bits), new Uint8Array(7)));
};

describe("pictures are validated and stripped", () => {
  it("a PNG keeps only its image chunks: text, EXIF, ICC and what follows IEND are dropped", () => {
    const input = concat(
      png(
        128,
        128,
        chunk("tEXt", text("Author\0someone")),
        chunk("eXIf", new Uint8Array(12)),
        chunk("iCCP", text("profile\0\0data")),
        chunk("sRGB", Uint8Array.of(0)),
      ),
      text("trailing bytes after the end"),
    );
    const result = stripImage(input, "avatar");
    if ("problem" in result) throw new Error(result.problem.message);
    expect(result).toMatchObject({ type: "image/png", width: 128, height: 128 });
    expect(chunkTypes(result.bytes)).toEqual(["IHDR", "sRGB", "IDAT", "IEND"]);
  });

  it("an animated PNG loses its animation chunks", () => {
    const result = stripImage(
      png(200, 100, chunk("acTL", new Uint8Array(8)), chunk("fcTL", new Uint8Array(26))),
      "avatar",
    );
    if ("problem" in result) throw new Error(result.problem.message);
    expect(chunkTypes(result.bytes)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("a JPEG keeps its frame, tables and scan, dropping EXIF, XMP, ICC, comments and trailers", () => {
    const input = concat(
      jpeg(
        300,
        200,
        app(0xe0, "JFIF\0"),
        app(0xe1, "Exif\0\0camera"),
        app(0xe2, "ICC_PROFILE\0"),
        app(0xfe, "a comment"),
      ),
      text("appended"),
    );
    const result = stripImage(input, "avatar");
    if ("problem" in result) throw new Error(result.problem.message);
    expect(result).toMatchObject({ type: "image/jpeg", width: 300, height: 200 });
    const out = new TextDecoder("latin1").decode(result.bytes);
    for (const gone of ["JFIF", "Exif", "ICC_PROFILE", "a comment", "appended"])
      expect(out).not.toContain(gone);
    expect(result.bytes.slice(-2)).toEqual(Uint8Array.of(0xff, 0xd9));
    // The scan's stuffed byte and restart marker are kept in the image data.
    expect(out).toContain("\u0012ÿ\u00004ÿÐV");
  });

  it("a WebP keeps its image chunk and drops EXIF, XMP and ICC", () => {
    const extended = new Uint8Array(10);
    extended[0] = 0x2c;
    extended.set([127, 0, 0], 4);
    extended.set([127, 0, 0], 7);
    const input = riff(
      webpChunk("VP8X", extended),
      webpChunk("ICCP", text("icc")),
      vp8l(128, 128),
      webpChunk("EXIF", text("exif")),
      webpChunk("XMP ", text("<x:xmpmeta/>")),
    );
    const result = stripImage(input, "avatar");
    if ("problem" in result) throw new Error(result.problem.message);
    expect(result).toMatchObject({ type: "image/webp", width: 128, height: 128 });
    const out = new TextDecoder("latin1").decode(result.bytes);
    expect(out).toContain("VP8L");
    for (const gone of ["VP8X", "ICCP", "EXIF", "XMP", "xmpmeta"]) expect(out).not.toContain(gone);
  });

  it.each([
    [
      "not a picture at all",
      text("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      "PNG, JPEG or WebP",
    ],
    [
      "a PNG with a damaged chunk",
      concat(signature, chunk("IHDR", new Uint8Array(13), true)),
      "CRC",
    ],
    ["a PNG cut short", png(128, 128).subarray(0, 40), "ends before"],
    ["an avatar too small", png(32, 32), "64 to 1024"],
    ["an avatar too large", png(2048, 2048), "64 to 1024"],
    ["an avatar wider than 2:1", png(600, 100), "2:1"],
    ["an avatar over 512 KB", concat(png(128, 128), new Uint8Array(600 * 1024)), "512 KB"],
    ["an animated WebP", riff(webpChunk("ANIM", new Uint8Array(6)), vp8l(128, 128)), "animated"],
    ["a JPEG with no scan", jpeg(128, 128).subarray(0, 120), "JPEG"],
  ])("%s is refused", (_label, bytes, words) => {
    const result = stripImage(bytes, "avatar");
    expect("problem" in result && result.problem.message).toContain(words);
  });

  it("a listing picture takes 320 to 4096 pixels a side", () => {
    expect("problem" in stripImage(png(128, 128), "preview")).toBe(true);
    expect("problem" in stripImage(png(1280, 800), "preview")).toBe(false);
  });
});
