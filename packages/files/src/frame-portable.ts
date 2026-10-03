import { CHUNK_SIZE, FileError } from "./portable-types.ts";
/** Portable envelope decoder shared by browser, Expo and the Node file-transfer owner. */
export function decodePortableFileFrame(frame: Uint8Array): {
  channel: number;
  offset: number;
  bytes: Uint8Array;
} {
  if (frame.length <= 16 || frame.length > CHUNK_SIZE + 16)
    throw new FileError("INVALID_FRAME", "Invalid binary envelope");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0) !== 0x41434546)
    throw new FileError("INVALID_FRAME", "Invalid binary envelope");
  const channel = view.getUint32(4);
  const offset = view.getBigUint64(8);
  if (!channel || offset > BigInt(Number.MAX_SAFE_INTEGER))
    throw new FileError("INVALID_FRAME", "Invalid channel or offset");
  return { channel, offset: Number(offset), bytes: frame.subarray(16) };
}
