import { ClientError } from "./types.ts";
function digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}
/** The platform's own base64 decoder (ES2026), where it has one. */
interface NativeBase64 {
  fromBase64?: (text: string, options: { lastChunkHandling: "strict" }) => Uint8Array<ArrayBuffer>;
}
const platform: NativeBase64 = Uint8Array;

/**
 * Decode bounded wire chunks without Buffer: natively where the platform can (JavaScriptCore
 * without a JIT takes ~30 ms for a 256 KiB part in JavaScript, well under 1 ms natively).
 */
export function decodeBase64(text: string, limit: number): Uint8Array<ArrayBuffer> {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const length = (text.length / 4) * 3 - padding;
  if (text.length % 4 || length > limit || length < 0) throw new ClientError("protocol");
  if (platform.fromBase64) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = platform.fromBase64(text, { lastChunkHandling: "strict" });
    } catch {
      throw new ClientError("protocol");
    }
    // The native decoder skips whitespace, which the wire never carries: the length shows it.
    if (bytes.length !== length) throw new ClientError("protocol");
    return bytes;
  }
  return decodeInScript(text, length, padding);
}

function decodeInScript(text: string, length: number, padding: number): Uint8Array<ArrayBuffer> {
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
