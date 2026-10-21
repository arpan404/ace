/*
 * Bytes on their way to Swift: chunked downloads gathered under a cap, and base64 for the JSON
 * patch that carries them. Shared by the native media viewer and the Files screen.
 */

/** Every chunk of `chunks` as one array, or how far it got once more than `limit` arrive. */
export async function gather(
  chunks: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array } | { over: number }> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    // Leaving the loop cancels the transfer; nothing past the cap is read.
    if (size > limit) return { over: size };
    parts.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes };
}

/** Standard base64 of `bytes`, built in 8 KiB slices so no call gets a huge argument list. */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(parts.join(""));
}
