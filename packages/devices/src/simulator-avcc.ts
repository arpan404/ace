import { spsDimensions } from "./h264-sps.ts";

/**
 * serve-sim's `/stream.avcc` is a sequence of records: a 32-bit big-endian length, then that
 * many bytes, the first of which is a tag. Tag 1 carries an avcC decoder configuration, 2 an
 * IDR access unit and 3 a delta access unit, both as length-prefixed NAL units. Other tags (a
 * JPEG preview seed, future additions) are handed on raw, never treated as an error.
 */
export type AvccRecord =
  | { kind: "description"; body: Buffer }
  | { kind: "key"; body: Buffer }
  | { kind: "delta"; body: Buffer }
  | { kind: "other"; tag: number; body: Buffer };

const recordLimit = 8 * 1024 * 1024;

/** Incremental record splitter. Work per chunk is proportional to the chunk, not the stream. */
export class AvccRecords {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private readonly emit: (record: AvccRecord) => void;
  constructor(emit: (record: AvccRecord) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 4) {
      const length = this.peekLength();
      if (length < 1 || length > recordLimit) throw new Error("Simulator video record is invalid");
      if (this.buffered < 4 + length) return;
      const record = this.take(4 + length).subarray(4);
      const tag = record[0] ?? 0;
      const body = record.subarray(1);
      this.emit(
        tag === 1
          ? { kind: "description", body }
          : tag === 2
            ? { kind: "key", body }
            : tag === 3
              ? { kind: "delta", body }
              : { kind: "other", tag, body },
      );
    }
  }
  private peekLength(): number {
    const first = this.chunks[0];
    if (first && first.length >= 4) return first.readUInt32BE(0);
    return this.take(4, false).readUInt32BE(0);
  }
  private take(count: number, consume = true): Buffer {
    const first = this.chunks[0];
    let joined: Buffer;
    if (first && first.length >= count) joined = first;
    else {
      joined = Buffer.concat(this.chunks, this.buffered);
      this.chunks = [joined];
    }
    if (!consume) return joined;
    const taken = joined.subarray(0, count);
    const rest = joined.subarray(count);
    this.chunks[0] = rest;
    if (!rest.length) this.chunks.shift();
    this.buffered -= count;
    return taken;
  }
}

/** What an avcC record says about the stream that follows it (ISO/IEC 14496-15 §5.3.3.1). */
export type AvcConfig = {
  /** WebCodecs codec string, `avc1.PPCCLL`. */
  codec: string;
  lengthSize: number;
  width: number;
  height: number;
  /** SPS then PPS, each with an Annex B start code, ready to lead a keyframe. */
  parameterSets: Buffer;
};

export function avcConfig(record: Buffer): AvcConfig {
  if (record.length < 7 || record[0] !== 1) throw new Error("Simulator video description invalid");
  const codec = `avc1.${record.subarray(1, 4).toString("hex").toUpperCase()}`;
  const lengthSize = ((record[4] ?? 0) & 3) + 1;
  if (lengthSize === 3) throw new Error("Simulator video NAL length size invalid");
  const sets: Buffer[] = [];
  let sps: Buffer | undefined;
  let offset = 5;
  for (const kind of ["sps", "pps"] as const) {
    const mask = kind === "sps" ? 31 : 255;
    const count = (record[offset++] ?? 0) & mask;
    for (let index = 0; index < count; index++) {
      if (offset + 2 > record.length) throw new Error("Simulator video description truncated");
      const length = record.readUInt16BE(offset);
      const nal = record.subarray(offset + 2, offset + 2 + length);
      if (!length || nal.length !== length)
        throw new Error("Simulator video description truncated");
      offset += 2 + length;
      if (kind === "sps") sps ??= nal;
      sets.push(startCode, nal);
    }
  }
  if (!sps) throw new Error("Simulator video description has no SPS");
  return { codec, lengthSize, ...spsDimensions(sps), parameterSets: Buffer.concat(sets) };
}

const startCode = Buffer.from([0, 0, 0, 1]);

/**
 * Rewrite one length-prefixed access unit as Annex B: each length prefix becomes a start code
 * and a keyframe is led by the parameter sets, so a decoder can join at any IDR without a
 * separate description. The NAL bytes are copied once and never decoded.
 */
export function annexB(sample: Buffer, config: AvcConfig, keyframe: boolean): Buffer {
  const lead = keyframe ? config.parameterSets : Buffer.alloc(0);
  const extra = 4 - config.lengthSize;
  let units = 0;
  for (let offset = 0; offset < sample.length; units++) {
    const length = sample.readUIntBE(offset, config.lengthSize);
    offset += config.lengthSize + length;
    if (!length || offset > sample.length) throw new Error("Simulator video sample is truncated");
  }
  const out = Buffer.allocUnsafe(lead.length + sample.length + units * extra);
  lead.copy(out);
  let write = lead.length;
  for (let offset = 0; offset < sample.length;) {
    const length = sample.readUIntBE(offset, config.lengthSize);
    offset += config.lengthSize;
    write += startCode.copy(out, write);
    write += sample.copy(out, write, offset, offset + length);
    offset += length;
  }
  return out;
}
