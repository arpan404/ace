import { ClientError } from "./types.ts";
/** Decode one bounded UTF-16LE chunk, carrying at most one high surrogate. */
export function decodeUtf16(bytes: Uint8Array, carry: string): { text: string; carry: string } {
  if (bytes.length % 2) throw new ClientError("protocol", "Incomplete text code unit");
  const parts = [carry];
  for (let start = 0; start < bytes.length; start += 8192) {
    const units: number[] = [];
    for (let index = start; index < Math.min(start + 8192, bytes.length); index += 2)
      units.push((bytes[index] ?? 0) | ((bytes[index + 1] ?? 0) << 8));
    parts.push(String.fromCharCode(...units));
  }
  let text = parts.join("");
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return { text: text.slice(0, -1), carry: text.slice(-1) };
  return { text, carry: "" };
}

/** Replay stored text in the same bounded chunks as a wire read, without splitting a pair. */
export function* textChunks(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 128 * 1024, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(start, end);
    start = end;
  }
}
