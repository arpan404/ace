import { decodePortableFileFrame } from "./frame-portable.ts";
import { CHUNK_SIZE, FileError } from "./types.ts";

/** Shared binary channel for workspace and blob transfers. No base64 or JSON copies. */
export function encodeFileFrame(channel: number, offset: number, bytes: Uint8Array): Buffer {
  if (
    !Number.isInteger(channel) ||
    channel < 1 ||
    channel > 0xffffffff ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !bytes.length ||
    bytes.length > CHUNK_SIZE
  )
    throw new FileError("INVALID_FRAME", "Invalid binary envelope");
  return fillFileFrame(Buffer.allocUnsafe(16 + bytes.length), channel, offset, bytes);
}

/** A socket may reuse this storage only after the previous write callback. */
export function fillFileFrame(
  frame: Buffer,
  channel: number,
  offset: number,
  bytes: Uint8Array,
): Buffer {
  frame.writeUInt32BE(0x41434546, 0);
  frame.writeUInt32BE(channel, 4);
  frame.writeBigUInt64BE(BigInt(offset), 8);
  frame.set(bytes, 16);
  return frame.subarray(0, 16 + bytes.length);
}
export function decodeFileFrame(frame: Buffer): { channel: number; offset: number; bytes: Buffer } {
  const decoded = decodePortableFileFrame(frame);
  return { channel: decoded.channel, offset: decoded.offset, bytes: frame.subarray(16) };
}
