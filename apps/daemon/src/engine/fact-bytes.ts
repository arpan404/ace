/** UTF-8 bytes of `JSON.stringify(text)`, counted without building it. */
export function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      if (unit === 34 || unit === 92) bytes += 2;
      else if (unit >= 32) bytes += 1;
      else bytes += unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
    } else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
/**
 * UTF-8 bytes of `JSON.stringify(facts)` for streamed facts, which are flat records: string
 * fields, an append among them, are counted in place, so a batch of deltas is never serialised
 * only to be measured. Any other field is serialised alone.
 */
export function streamedFactsBytes(facts: readonly object[]): number {
  let bytes = 2 + Math.max(0, facts.length - 1);
  for (const fact of facts) {
    let fields = 0;
    bytes += 2;
    for (const [key, value] of Object.entries(fact)) {
      const size =
        typeof value === "string"
          ? jsonStringBytes(value)
          : value === undefined || typeof value === "function" || typeof value === "symbol"
            ? 0
            : Buffer.byteLength(JSON.stringify(value));
      if (!size) continue;
      bytes += (fields++ ? 1 : 0) + jsonStringBytes(key) + 1 + size;
    }
  }
  return bytes;
}
