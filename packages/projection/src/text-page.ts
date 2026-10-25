/** How a stored text stream is encoded: message text as UTF-16LE, shell output as UTF-8. */
export type StreamEncoding = "utf-16le" | "utf-8";

/** The longest prefix of `bytes` that ends on a whole character; the rest belongs to the next read. */
export function wholeCharacterLength(bytes: Uint8Array, encoding: StreamEncoding): number {
  let used = bytes.length;
  if (encoding === "utf-16le") {
    used -= used % 2;
    if (used >= 2) {
      const unit = (bytes[used - 2] ?? 0) + ((bytes[used - 1] ?? 0) << 8);
      if (unit >= 0xd800 && unit <= 0xdbff) used -= 2;
    }
    return used;
  }
  let start = used - 1;
  while (start >= 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
  if (start < 0) return used;
  const first = bytes[start] ?? 0;
  const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return start + width > used ? start : used;
}

// ignoreBOM keeps a U+FEFF that happens to start a page; it is text, not a marker.
const utf16 = new TextDecoder("utf-16le", { ignoreBOM: true });
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Bytes to skip when a read starts inside a character, as an offset from before this format did. */
function partialLead(bytes: Uint8Array, offset: number, encoding: StreamEncoding): number {
  if (offset === 0) return 0;
  if (encoding === "utf-8") {
    let skip = 0;
    while (skip < bytes.length && ((bytes[skip] ?? 0) & 0xc0) === 0x80) skip++;
    return skip;
  }
  const skip = offset % 2;
  const unit = (bytes[skip] ?? 0) + ((bytes[skip + 1] ?? 0) << 8);
  return bytes.length >= skip + 2 && unit >= 0xdc00 && unit <= 0xdfff ? skip + 2 : skip;
}

/**
 * Decode one page of a stored text stream read from `offset`. The page ends on a whole character,
 * so passing `nextOffset` back reads the following text with nothing split or repeated. A page
 * that can't hold one whole character keeps its bytes, so reading always makes progress.
 */
export function decodeTextPage(
  page: { bytes: Uint8Array; eof: boolean },
  offset: number,
  encoding: StreamEncoding,
): { text: string; nextOffset: number; eof: boolean } {
  const bytes = page.bytes;
  const start = Math.min(bytes.length, partialLead(bytes, offset, encoding));
  const whole = start + wholeCharacterLength(bytes.subarray(start), encoding);
  const end = whole > start ? whole : bytes.length;
  return {
    text: (encoding === "utf-16le" ? utf16 : utf8).decode(bytes.subarray(start, end)),
    nextOffset: offset + end,
    eof: page.eof && end === bytes.length,
  };
}
