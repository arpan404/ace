import { ClientError } from "./types.ts";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Decode bounded wire chunks without Buffer or platform-specific globals. */
export function decodeBase64(text: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new ClientError("protocol");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let index = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i] ?? "");
    const b = alphabet.indexOf(text[i + 1] ?? "");
    const c = alphabet.indexOf(text[i + 2] ?? "");
    const d = alphabet.indexOf(text[i + 3] ?? "");
    bytes[index++] = (a << 2) | (b >> 4);
    if (index < bytes.length) bytes[index++] = (b << 4) | (c >> 2);
    if (index < bytes.length) bytes[index++] = (c << 6) | d;
  }
  return bytes;
}
