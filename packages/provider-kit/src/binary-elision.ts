/**
 * Attachment bytes in recorded provider frames.
 *
 * Images, PDFs and other files reach providers inline as base64 or base64 data URLs, and
 * providers echo them back in user messages and tool results. Those bytes belong to the
 * attachment, not to the frame: a frame records the structure around them, so frames stay
 * small whatever the person attaches. Each elided string becomes a short marker carrying the
 * decoded size and SHA-256, which is how uploaded attachments are hashed, so an echo can still
 * be matched to the attachment it carries.
 */
import { createHash } from "node:crypto";

/** A string at least this long that is only base64 (or a base64 data URL) is attachment bytes. */
export const binaryElisionChars = 16 * 1024;

const base64Alphabet = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_")
  base64Alphabet[c.charCodeAt(0)] = 1;
const dataUrl = /^data:([\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*);base64,/;
const marker = /^\[ace: (\d+) bytes of (.{1,300}) elided; sha256 ([a-f0-9]{64})\]$/;

function elide(value: string): string {
  if (value.length < binaryElisionChars) return value;
  const header = dataUrl.exec(value.slice(0, 320));
  const start = header ? header[0].length : 0;
  for (let i = start; i < value.length; i++)
    if (base64Alphabet[value.charCodeAt(i)] !== 1) return value;
  const bytes = Buffer.from(value.slice(start), "base64");
  const label = header ? `data:${header[1]};base64` : "base64 data";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return `[ace: ${bytes.length} bytes of ${label} elided; sha256 ${sha256}]`;
}

/**
 * JSON text of `value` with attachment bytes replaced by digest markers. Prose, code and every
 * other string are kept whole. Work is one serialization for small values; only a value long
 * enough to hold attachment bytes is visited string by string.
 */
export function elidedJson(value: unknown): string {
  const plain = JSON.stringify(value);
  if (plain.length < binaryElisionChars) return plain;
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" ? elide(entry) : entry,
  );
}

/** The SHA-256 of the bytes an elision marker stands for, or undefined for any other string. */
export function elidedDigest(value: string): string | undefined {
  return value.length <= 420 ? marker.exec(value)?.[3] : undefined;
}
