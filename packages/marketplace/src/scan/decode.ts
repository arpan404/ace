/*
 * How the scanner turns a file's bytes into text (ADR 0174 §8). UTF-8 first; then UTF-16 when the
 * file opens with its byte-order mark; then, for anything else without a NUL byte, a lossless
 * single-byte reading (each byte its own code point), so Latin-1 or Windows-1252 source can't
 * escape the script rules by failing UTF-8. A file with NUL bytes and no UTF-16 mark is binary:
 * the `files` check reads its first bytes instead. Pure.
 */

export type ScanEncoding = "utf-8" | "utf-16le" | "utf-16be" | "single-byte";

export interface ScanText {
  text: string;
  encoding: ScanEncoding;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const utf16le = new TextDecoder("utf-16le");
const utf16be = new TextDecoder("utf-16be");

/** Bytes per `String.fromCharCode` call: well under any engine's argument limit. */
const CHUNK = 8192;

/** Each byte as the code point of the same number: Latin-1, lossless for every byte. */
function singleByte(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + CHUNK)));
  return parts.join("");
}

/** The text of `bytes` as the scanner reads it, or undefined when the file is binary. */
export function scanText(bytes: Uint8Array): ScanText | undefined {
  try {
    return { text: utf8.decode(bytes), encoding: "utf-8" };
  } catch {
    // Not UTF-8: try the other ways text arrives.
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: utf16le.decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: utf16be.decode(bytes.subarray(2)), encoding: "utf-16be" };
  if (bytes.includes(0)) return undefined;
  return { text: singleByte(bytes), encoding: "single-byte" };
}
