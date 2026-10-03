import { ClientError } from "./types.ts";
function digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}
/** Decode bounded wire chunks without Buffer or platform-specific globals. */
export function decodeBase64(text: string, limit: number): Uint8Array {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const length = (text.length / 4) * 3 - padding;
  if (text.length % 4 || length > limit || length < 0) throw new ClientError("protocol");
  const bytes = new Uint8Array(length);
  let index = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = digit(text.charCodeAt(i));
    const b = digit(text.charCodeAt(i + 1));
    const c = digit(text.charCodeAt(i + 2));
    const d = digit(text.charCodeAt(i + 3));
    const last = i + 4 === text.length;
    if (
      a < 0 ||
      b < 0 ||
      (c < 0 && !(last && padding === 2 && text[i + 2] === "=")) ||
      (d < 0 && !(last && padding && text[i + 3] === "=")) ||
      (last && padding === 2 && b & 15) ||
      (last && padding === 1 && c & 3)
    )
      throw new ClientError("protocol");
    bytes[index++] = (a << 2) | (b >> 4);
    if (index < bytes.length) bytes[index++] = (b << 4) | (c >> 2);
    if (index < bytes.length) bytes[index++] = (c << 6) | d;
  }
  return bytes;
}
