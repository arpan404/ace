/*
 * The desktop's encoder events on its backend socket (ADR 0088, embedded backend): one binary
 * WebSocket message per event, so a chunk's bytes travel as they are, not as base64 in JSON.
 *
 *   0  4 bytes  "aceV"
 *   4  u32      header length
 *   8  ..       header: the encoder's event (`VideoEncoderEvent`), JSON in UTF-8
 *   .. ..       the chunk's bytes (none for `failed` and `ended`)
 *
 * The receiver parses the header with `VideoEncoderEvent`; nothing here trusts it.
 */

const magic = [0x61, 0x63, 0x65, 0x56];
/** An encoder event is a few hundred bytes; anything far larger is not one. */
const headerLimit = 16 * 1024;

export function encodeEmbeddedVideo(event: object, bytes?: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(JSON.stringify(event));
  if (header.length > headerLimit) throw new Error("Video event header too large");
  const frame = new Uint8Array(8 + header.length + (bytes?.length ?? 0));
  frame.set(magic, 0);
  new DataView(frame.buffer).setUint32(4, header.length);
  frame.set(header, 8);
  if (bytes) frame.set(bytes, 8 + header.length);
  return frame;
}

/** Whether a binary message is an encoder event (another channel's frames are not). */
export function isEmbeddedVideo(frame: Uint8Array): boolean {
  return frame.length >= 8 && magic.every((byte, index) => frame[index] === byte);
}

/**
 * The event's header (unparsed JSON) and its bytes; undefined for a frame that is not an
 * encoder event or is cut short. The bytes are a view into `frame`.
 */
export function decodeEmbeddedVideo(
  frame: Uint8Array,
): { header: unknown; bytes: Uint8Array | undefined } | undefined {
  if (!isEmbeddedVideo(frame)) return undefined;
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
  if (length > headerLimit || 8 + length > frame.length) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(8, 8 + length)),
    );
  } catch {
    return undefined;
  }
  const bytes = frame.subarray(8 + length);
  return { header, bytes: bytes.length ? bytes : undefined };
}
