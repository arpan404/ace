/*
 * What media bytes are, from the bytes alone (ADR 0096): a host's Content-Type is never
 * trusted. Only formats a browser shows in `<img>` or `<video>` are recognised; everything
 * else is refused. SVG is recognised only as an image file, which clients draw with `<img>`
 * (where its scripts never run), never inline.
 */

export type SniffedMedia = { kind: "image" | "video"; mimeType: string };

/** How many leading bytes `sniffMedia` and `mediaDimensions` look at. */
export const sniffBytes = 65_536;

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

/**
 * An image's pixel size from its header, so a page can reserve its space before the bytes
 * arrive: PNG, GIF, WebP and baseline or progressive JPEG (whose frame header may sit behind
 * metadata; past the bytes given, undefined). Implausible sizes are dropped.
 */
export function mediaDimensions(
  head: Uint8Array,
  mimeType: string,
): { width: number; height: number } | undefined {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const fits = (at: number, bytes: number) => head.length >= at + bytes;
  let size: { width: number; height: number } | undefined;
  if (mimeType === "image/png" && fits(16, 8))
    size = { width: view.getUint32(16), height: view.getUint32(20) };
  else if (mimeType === "image/gif" && fits(6, 4))
    size = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  else if (mimeType === "image/webp" && fits(12, 18)) {
    const chunk = ascii(head, 12, 16);
    if (chunk === "VP8X")
      size = {
        width: 1 + (view.getUint32(24, true) & 0xffffff),
        height: 1 + (view.getUint32(27, true) & 0xffffff),
      };
    else if (chunk === "VP8 " && fits(26, 4))
      size = {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    else if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      size = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  } else if (mimeType === "image/jpeg") {
    for (let at = 2; fits(at, 9);) {
      if (head[at] !== 0xff) break;
      const marker = head[at + 1] ?? 0;
      const length = view.getUint16(at + 2);
      // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        size = { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        break;
      }
      at += 2 + length;
    }
  }
  if (!size || size.width < 1 || size.height < 1 || size.width > 65_535 || size.height > 65_535)
    return undefined;
  return size;
}
