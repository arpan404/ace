/** The compression a relayed channel asks the daemon for, when this platform can undo it. */
export function relayCompression(): string[] {
  return typeof DecompressionStream === "function" ? ["deflate-raw"] : [];
}

/**
 * Inflates one deflated relay message with the platform's own decompressor, refusing output
 * past `limit` bytes so a small message can't expand without bound.
 */
export async function inflateRaw(deflated: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // A corrupt message fails the read below too; this rejection carries nothing new.
  void writer
    .write(new Uint8Array(deflated))
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
      throw new Error("Relay message limit");
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
