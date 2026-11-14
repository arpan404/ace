/** MediaFrame v1. All integers are big endian. Unknown flag bits and header extensions survive. */
export interface MediaFrame {
  kind: number;
  flags: number;
  ageUs: number;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  scale: number;
  rotation: number;
  codec: number;
  encode: number;
  epoch: number;
  codecString: string;
  description: Uint8Array;
  extension: Uint8Array;
  payload: Uint8Array;
}
const fields = [
  ["flags", 12, 4],
  ["ageUs", 16, 4],
  ["width", 20, 2],
  ["height", 22, 2],
  ["displayWidth", 24, 2],
  ["displayHeight", 26, 2],
  ["scale", 28, 2],
  ["rotation", 30, 1],
  ["codec", 31, 1],
  ["encode", 32, 4],
  ["epoch", 36, 4],
] as const;
function valid(frame: MediaFrame): void {
  if (
    frame.kind < 1 ||
    frame.kind > 5 ||
    !Number.isInteger(frame.kind) ||
    frame.rotation > 3 ||
    frame.codec > 9 ||
    (frame.codec === 0 && frame.kind !== 4 && frame.kind !== 5)
  )
    throw new Error("Invalid media kind, rotation or codec");
  if (Array.from(frame.codecString).some((char) => (char.codePointAt(0) ?? 0) > 127))
    throw new Error("Non-ASCII codec");
  for (const [key, , size] of fields) {
    const value = frame[key];
    if (!Number.isInteger(value) || value < 0 || value > 2 ** (size * 8) - 1)
      throw new Error("Invalid media integer");
  }
  if (
    frame.payload.length > 8 * 1024 * 1024 ||
    frame.description.length > 65535 ||
    44 + frame.codecString.length + frame.description.length + frame.extension.length > 4096
  )
    throw new Error("Media frame too large");
  if (frame.kind === 5 && frame.payload.length !== 32)
    throw new Error("Invalid hello token length");
}
export function encodeMediaFrame(frame: MediaFrame): Uint8Array {
  valid(frame);
  const h = 44 + frame.codecString.length + frame.description.length + frame.extension.length;
  const bytes = new Uint8Array(h + frame.payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4143454d);
  view.setUint8(4, 1);
  view.setUint8(5, frame.kind);
  view.setUint16(6, h);
  view.setUint32(8, frame.payload.length);
  for (const [key, offset, size] of fields) {
    if (size === 4) view.setUint32(offset, frame[key]);
    else if (size === 2) view.setUint16(offset, frame[key]);
    else view.setUint8(offset, frame[key]);
  }
  view.setUint16(40, frame.codecString.length);
  view.setUint16(42, frame.description.length);
  bytes.set(new TextEncoder().encode(frame.codecString), 44);
  bytes.set(frame.description, 44 + frame.codecString.length);
  bytes.set(frame.extension, 44 + frame.codecString.length + frame.description.length);
  bytes.set(frame.payload, h);
  return bytes;
}
export function decodeMediaFrame(bytes: Uint8Array): MediaFrame {
  if (bytes.length < 44) throw new Error("Truncated media header");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = v.getUint16(6),
    p = v.getUint32(8),
    c = v.getUint16(40),
    d = v.getUint16(42);
  if (
    v.getUint32(0) !== 0x4143454d ||
    v.getUint8(4) !== 1 ||
    h < 44 ||
    h > 4096 ||
    p > 8 * 1024 * 1024 ||
    h + p !== bytes.length ||
    44 + c + d > h
  )
    throw new Error("Invalid media frame lengths or version");
  const codecBytes = bytes.subarray(44, 44 + c);
  if (codecBytes.some((b) => b > 127)) throw new Error("Non-ASCII codec");
  const frame: MediaFrame = {
    kind: v.getUint8(5),
    flags: v.getUint32(12),
    ageUs: v.getUint32(16),
    width: v.getUint16(20),
    height: v.getUint16(22),
    displayWidth: v.getUint16(24),
    displayHeight: v.getUint16(26),
    scale: v.getUint16(28),
    rotation: v.getUint8(30),
    codec: v.getUint8(31),
    encode: v.getUint32(32),
    epoch: v.getUint32(36),
    codecString: new TextDecoder().decode(codecBytes),
    description: bytes.slice(44 + c, 44 + c + d),
    extension: bytes.slice(44 + c + d, h),
    payload: bytes.slice(h),
  };
  valid(frame);
  return frame;
}
export function encodeEgress(handle: number, sequence: number, frame: MediaFrame): Uint8Array {
  for (const n of [handle, sequence])
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("Invalid egress integer");
  const body = encodeMediaFrame(frame),
    bytes = new Uint8Array(12 + body.length);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0x41434545);
  v.setUint32(4, handle);
  v.setUint32(8, sequence);
  bytes.set(body, 12);
  return bytes;
}
export function decodeEgress(bytes: Uint8Array): {
  handle: number;
  sequence: number;
  frame: MediaFrame;
} {
  if (bytes.length < 56) throw new Error("Truncated egress");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== 0x41434545) throw new Error("Invalid egress magic");
  return {
    handle: v.getUint32(4),
    sequence: v.getUint32(8),
    frame: decodeMediaFrame(bytes.subarray(12)),
  };
}
