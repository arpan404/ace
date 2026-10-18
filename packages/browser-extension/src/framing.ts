/**
 * Chrome native messaging framing: each message is a 4-byte length in native byte order (little
 * endian on every platform ace ships) followed by that many bytes of UTF-8 JSON.
 */
export class NativeMessageTooLarge extends Error {}

/** Encodes one message, refusing anything over `limit` bytes (Chrome kills the port instead). */
export function encodeNativeMessage(message: unknown, limit: number): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > limit)
    throw new NativeMessageTooLarge(`Native message of ${body.length} bytes exceeds ${limit}`);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Splits a byte stream into messages. Chunks may hold part of a frame or several frames. A frame
 * over the limit means the stream cannot be trusted and throws; a frame that is not JSON is
 * skipped, since its length still says where the next one starts.
 */
export class NativeMessageDecoder {
  private limit: number;
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** The body length of the frame being received, once its header is in. */
  private expected: number | undefined;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(chunk: Buffer): unknown[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const messages: unknown[] = [];
    for (;;) {
      if (this.expected === undefined) {
        if (this.buffered < 4) break;
        const length = this.joined().readUInt32LE(0);
        if (length > this.limit)
          throw new NativeMessageTooLarge(
            `Native message of ${length} bytes exceeds ${this.limit}`,
          );
        this.expected = length;
      }
      // Bytes are joined only once a whole frame is in, so a large frame costs one copy.
      if (this.buffered < 4 + this.expected) break;
      const joined = this.joined();
      const body = joined.subarray(4, 4 + this.expected);
      const rest = joined.subarray(4 + this.expected);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      this.expected = undefined;
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        // Not JSON: skip it; the framing is intact.
      }
    }
    return messages;
  }
  private joined(): Buffer {
    const joined = this.chunks.length === 1 ? this.chunks[0] : undefined;
    if (joined) return joined;
    const all = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [all];
    return all;
  }
}
