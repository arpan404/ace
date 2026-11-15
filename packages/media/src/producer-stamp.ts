/**
 * The producer stamp (docs/media/plan.md, "Producer stamp"): a MediaFrame header extension a
 * producer adds so the daemon can rebuild its own frame header after egress. ace-media passes
 * extensions through untouched. Layout, big endian: u16 tag 1, u16 length 24, u64 the
 * producer's frame sequence, f64 its capture time (Unix ms), f64 its exact scale.
 */
export type ProducerStamp = { sequence: number; timestamp: number; scale: number };

const tag = 1;
const length = 24;

export function encodeProducerStamp(stamp: ProducerStamp): Uint8Array {
  const bytes = new Uint8Array(4 + length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, tag);
  view.setUint16(2, length);
  view.setBigUint64(4, BigInt(stamp.sequence));
  view.setFloat64(12, stamp.timestamp);
  view.setFloat64(20, stamp.scale);
  return bytes;
}

/** The stamp in a frame's extension bytes, skipping other tags; undefined when absent. */
export function readProducerStamp(extension: Uint8Array): ProducerStamp | undefined {
  const view = new DataView(extension.buffer, extension.byteOffset, extension.byteLength);
  let offset = 0;
  while (offset + 4 <= extension.byteLength) {
    const kind = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    const body = offset + 4;
    if (body + size > extension.byteLength) return undefined;
    if (kind === tag && size === length) {
      const sequence = view.getBigUint64(body);
      if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      const timestamp = view.getFloat64(body + 8);
      const scale = view.getFloat64(body + 16);
      if (!Number.isFinite(timestamp) || !Number.isFinite(scale) || scale <= 0) return undefined;
      return { sequence: Number(sequence), timestamp, scale };
    }
    offset = body + size;
  }
  return undefined;
}
