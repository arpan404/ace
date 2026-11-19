/** Caller owns and wipes all buffers. Keys never pass through JSON. */
export interface KeyBlock {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  sendNonce: bigint;
  receiveNonce: bigint;
  framesSent: bigint;
  framesReceived: bigint;
  flags: number;
  window: number;
  unacked: number;
  owed: number;
  uncounted: number;
}
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function encodeKeyBlock(block: KeyBlock, target: Uint8Array): void {
  if (
    target.length !== 120 ||
    block.sendKey.length !== 32 ||
    block.receiveKey.length !== 32 ||
    !Number.isInteger(block.flags) ||
    block.flags < 0 ||
    block.flags > 3
  )
    throw new Error("Invalid key block");
  for (const n of [block.sendNonce, block.receiveNonce, block.framesSent, block.framesReceived])
    if (n < 0n || n > 0xffffffffffffffffn) throw new Error("Invalid key counter");
  for (const n of [block.window, block.unacked, block.owed, block.uncounted])
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("Invalid flow counter");
  const v = new DataView(target.buffer, target.byteOffset, target.byteLength);
  target.set(block.sendKey, 0);
  target.set(block.receiveKey, 32);
  v.setBigUint64(64, block.sendNonce);
  v.setBigUint64(72, block.receiveNonce);
  v.setBigUint64(80, block.framesSent);
  v.setBigUint64(88, block.framesReceived);
  target.fill(0, 96, 100);
  target[96] = block.flags;
  v.setUint32(100, block.window);
  v.setUint32(104, block.unacked);
  v.setUint32(108, block.owed);
  v.setUint32(112, block.uncounted);
  v.setUint32(116, crc32c(target.subarray(0, 116)));
}
/** Key slices alias the input so wiping it wipes the decoded keys too. */
export function decodeKeyBlock(bytes: Uint8Array): KeyBlock {
  if (bytes.length !== 120) throw new Error("Invalid key block length");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.getUint8(96) > 3 ||
    v.getUint8(97) !== 0 ||
    v.getUint16(98) !== 0 ||
    v.getUint32(116) !== crc32c(bytes.subarray(0, 116))
  )
    throw new Error("Invalid key block flags, reserved bytes or CRC");
  return {
    sendKey: bytes.subarray(0, 32),
    receiveKey: bytes.subarray(32, 64),
    sendNonce: v.getBigUint64(64),
    receiveNonce: v.getBigUint64(72),
    framesSent: v.getBigUint64(80),
    framesReceived: v.getBigUint64(88),
    flags: v.getUint8(96),
    window: v.getUint32(100),
    unacked: v.getUint32(104),
    owed: v.getUint32(108),
    uncounted: v.getUint32(112),
  };
}
