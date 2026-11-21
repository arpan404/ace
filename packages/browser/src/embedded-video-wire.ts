/*
 * The desktop's encoder events on its backend socket (ADR 0088, embedded backend): one binary
 * WebSocket message per event, so they share the socket with other channels' binary frames.
 * Chunks never travel here: the encoder streams them into ace-media's ingest.
 *
 *   0  4 bytes  "aceV"
 *   4  u32      header length
 *   8  ..       header: the encoder's event (`VideoEncoderEvent`), JSON in UTF-8
 *
 * The receiver parses the header with `VideoEncoderEvent`; nothing here trusts it.
 */

const magic = [0x61, 0x63, 0x65, 0x56];
/** An encoder event is a few hundred bytes; anything far larger is not one. */
const headerLimit = 16 * 1024;

export function encodeEmbeddedVideo(event: object): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(JSON.stringify(event));
  if (header.length > headerLimit) throw new Error("Video event header too large");
  const frame = new Uint8Array(8 + header.length);
  frame.set(magic, 0);
  new DataView(frame.buffer).setUint32(4, header.length);
  frame.set(header, 8);
  return frame;
}

/** Whether a binary message is an encoder event (another channel's frames are not). */
export function isEmbeddedVideo(frame: Uint8Array): boolean {
  return frame.length >= 8 && magic.every((byte, index) => frame[index] === byte);
}

/**
 * The event's header (unparsed JSON); undefined for a frame that is not an encoder event or is
 * cut short. Bytes after the header (an older desktop's chunk) are ignored.
 */
export function decodeEmbeddedVideo(frame: Uint8Array): { header: unknown } | undefined {
  if (!isEmbeddedVideo(frame)) return undefined;
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
  if (length > headerLimit || 8 + length > frame.length) return undefined;
  try {
    return {
      header: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(8, 8 + length)),
      ),
    };
  } catch {
    return undefined;
  }
}
