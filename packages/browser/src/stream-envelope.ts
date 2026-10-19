/*
 * The binary stream envelope: how a live stream's messages (JPEG frames and encoded video
 * chunks) cross a socket as binary WebSocket messages instead of base64 inside JSON.
 *
 * Sockets and the relay cap one binary message at 64 KiB, so a logical message is cut into
 * pieces. Every piece starts with the same 20-byte prefix (big-endian):
 *
 *   0  u32  magic "ACES"
 *   4  u8   version (1)
 *   5  u8   kind: what the message carries (`streamKinds`)
 *   6  u16  meta length: the kind's own header at the start of the body
 *   8  u32  message id, per sender
 *   12 u32  body length (meta + payload)
 *   16 u32  offset of this piece in the body
 *
 * A sender writes a message's pieces back to back, so a receiver holds one partial message at a
 * time. Portable: no Node built-ins, so browsers, the client worker and the daemon share it.
 */

/** "ACES", the first four bytes of every stream piece. */
export const streamMagic = 0x41434553;
export const streamVersion = 1;
/** Bytes before each piece's slice of the body. */
export const streamPrefixBytes = 20;
/** The largest binary message a piece may be (the relay and client cap is 64 KiB + 16). */
export const streamPieceBytes = 64 * 1024;
/** The largest logical message a receiver assembles. */
export const streamMaxBytes = 8 * 1024 * 1024;
/** Stream kinds. A receiver skips a kind it doesn't know. */
export const streamKinds = {
  /** One JPEG screencast frame of a thread's browser (`stream-frame.ts`). */
  browserFrame: 1,
  /** One encoded video chunk of a thread's browser (`stream-video.ts`, ADR 0088). */
  browserVideo: 2,
} as const;

export class StreamEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamEnvelopeError";
  }
}

/** One assembled stream message. */
export interface StreamEnvelope {
  kind: number;
  meta: Uint8Array;
  payload: Uint8Array;
}

/** Whether a binary message is a stream piece rather than another binary channel's frame. */
export function isStreamPiece(bytes: Uint8Array): boolean {
  if (bytes.length < streamPrefixBytes) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) === streamMagic;
}

/**
 * Cuts one message into binary messages of at most `streamPieceBytes`. The pieces are new
 * buffers, so one encoding can go to every viewer of the same frame.
 */
export function encodeStream(
  kind: number,
  id: number,
  meta: Uint8Array,
  payload: Uint8Array,
): Uint8Array[] {
  if (!Number.isInteger(kind) || kind < 1 || kind > 255) throw new StreamEnvelopeError("Bad kind");
  if (meta.length > 0xffff) throw new StreamEnvelopeError("Stream meta too large");
  const total = meta.length + payload.length;
  if (total > streamMaxBytes) throw new StreamEnvelopeError("Stream message too large");
  const room = streamPieceBytes - streamPrefixBytes;
  const pieces: Uint8Array[] = [];
  let offset = 0;
  do {
    const size = Math.min(room, total - offset);
    const piece = new Uint8Array(streamPrefixBytes + size);
    const view = new DataView(piece.buffer);
    view.setUint32(0, streamMagic);
    view.setUint8(4, streamVersion);
    view.setUint8(5, kind);
    view.setUint16(6, meta.length);
    view.setUint32(8, id >>> 0);
    view.setUint32(12, total);
    view.setUint32(16, offset);
    // The body is meta then payload; a piece may straddle the two.
    const end = offset + size;
    if (offset < meta.length)
      piece.set(meta.subarray(offset, Math.min(end, meta.length)), streamPrefixBytes);
    if (end > meta.length) {
      const from = Math.max(offset, meta.length);
      piece.set(
        payload.subarray(from - meta.length, end - meta.length),
        streamPrefixBytes + from - offset,
      );
    }
    pieces.push(piece);
    offset = end;
  } while (offset < total);
  return pieces;
}

interface Partial {
  kind: number;
  id: number;
  metaLength: number;
  body: Uint8Array;
  received: number;
}

/**
 * Puts pieces back together. A malformed piece throws; a new message starting while another is
 * partial replaces it (its sender gave up on it), since pieces of one message never interleave.
 */
export class StreamAssembler {
  #partial: Partial | undefined;
  push(bytes: Uint8Array): StreamEnvelope | undefined {
    if (bytes.length < streamPrefixBytes || bytes.length > streamPieceBytes)
      throw new StreamEnvelopeError("Stream piece out of bounds");
    const view = new DataView(bytes.buffer, bytes.byteOffset, streamPrefixBytes);
    if (view.getUint32(0) !== streamMagic) throw new StreamEnvelopeError("Not a stream piece");
    if (view.getUint8(4) !== streamVersion)
      throw new StreamEnvelopeError("Unsupported stream version");
    const kind = view.getUint8(5);
    const metaLength = view.getUint16(6);
    const id = view.getUint32(8);
    const total = view.getUint32(12);
    const offset = view.getUint32(16);
    const piece = bytes.subarray(streamPrefixBytes);
    if (total > streamMaxBytes || metaLength > total || offset + piece.length > total)
      throw new StreamEnvelopeError("Stream piece out of bounds");
    if (offset === 0)
      this.#partial = { kind, id, metaLength, body: new Uint8Array(total), received: 0 };
    const partial = this.#partial;
    if (
      !partial ||
      partial.id !== id ||
      partial.kind !== kind ||
      partial.metaLength !== metaLength ||
      partial.body.length !== total ||
      partial.received !== offset
    ) {
      this.#partial = undefined;
      throw new StreamEnvelopeError("Stream piece out of order");
    }
    partial.body.set(piece, offset);
    partial.received += piece.length;
    if (partial.received < total) {
      // Only an empty final piece could stall here, and offsets forbid one past the start.
      if (!piece.length) throw new StreamEnvelopeError("Empty stream piece");
      return undefined;
    }
    this.#partial = undefined;
    return {
      kind,
      meta: partial.body.subarray(0, metaLength),
      payload: partial.body.subarray(metaLength),
    };
  }
  /** Drop a partial message (the connection ended). */
  reset(): void {
    this.#partial = undefined;
  }
}
