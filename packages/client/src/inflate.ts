/*
 * Expanding compressed bytes from the daemon with the platform's own decompressor
 * (`DecompressionStream`: browsers, Node, and the iPhone bridge, which backs it with native zlib).
 * Checked on every use, not at load, so a host that installs its decompressor after this module
 * loads is still seen. A platform without one is never sent compressed bytes.
 */

/** Formats the daemon may compress with. */
export type Compression = "gzip" | "deflate-raw";

/** Whether this platform can expand what the daemon compresses. */
export function canInflate(): boolean {
  return typeof DecompressionStream === "function";
}

/** The compression a relayed channel asks the daemon for, when this platform can undo it. */
export function relayCompression(): string[] {
  return canInflate() ? ["deflate-raw"] : [];
}

/** Thrown when compressed bytes would expand past the caller's limit. */
export class InflateLimitError extends Error {
  constructor() {
    super("Inflate limit");
  }
}

/**
 * Expands `compressed`, refusing output past `limit` bytes so a small input can't expand
 * without bound. Corrupt input rejects.
 */
export async function inflate(
  format: Compression,
  compressed: Uint8Array,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  // A corrupt input fails the read below too; this rejection carries nothing new.
  void writer
    .write(new Uint8Array(compressed))
    .then(() => writer.close())
    .catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new InflateLimitError();
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
