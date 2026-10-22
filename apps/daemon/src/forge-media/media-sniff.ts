/*
 * What media bytes are, from the bytes alone (ADR 0096): a host's Content-Type is never
 * trusted. Only formats a browser shows in `<img>` or `<video>` are recognised; everything
 * else is refused. SVG is recognised only as an image file, which clients draw with `<img>`
 * (where its scripts never run), never inline.
 */

export type SniffedMedia = { kind: "image" | "video"; mimeType: string };

/** How many leading bytes `sniffMedia` looks at. */
export const sniffBytes = 4096;

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** An ISO base media file (MP4, QuickTime, AVIF) by its `ftyp` brand. */
function isoMedia(bytes: Uint8Array): SniffedMedia | undefined {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return undefined;
  const brand = ascii(bytes, 8, 12);
  if (brand === "avif" || brand === "avis") return { kind: "image", mimeType: "image/avif" };
  if (brand === "qt  ") return { kind: "video", mimeType: "video/quicktime" };
  // HEIF stills: Safari alone shows them, so they are not offered.
  if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return undefined;
  return { kind: "video", mimeType: "video/mp4" };
}

/** An SVG document: optional BOM, XML declaration, comments and doctype, then `<svg`. */
function isSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.startsWith("﻿")) text = text.slice(1);
  for (;;) {
    text = text.trimStart();
    const skip = /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype\s+svg[^>]*>)/i.exec(text);
    if (!skip) break;
    text = text.slice(skip[0].length);
  }
  return /^<svg[\s>]/i.test(text);
}

/** The media type of a file from its first `sniffBytes` bytes; undefined if it is no media. */
export function sniffMedia(head: Uint8Array): SniffedMedia | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "image", mimeType: "image/png" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mimeType: "image/jpeg" };
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(head, 0, 6)))
    return { kind: "image", mimeType: "image/gif" };
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP")
    return { kind: "image", mimeType: "image/webp" };
  if (startsWith(head, [0x42, 0x4d]) && head.length >= 14)
    return { kind: "image", mimeType: "image/bmp" };
  if (startsWith(head, [0, 0, 1, 0]) && head.length >= 6)
    return { kind: "image", mimeType: "image/x-icon" };
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mimeType: "video/webm" };
  const iso = isoMedia(head);
  if (iso) return iso;
  if (isSvg(head)) return { kind: "image", mimeType: "image/svg+xml" };
  return undefined;
}
