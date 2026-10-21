import { spsDimensions } from "./h264-sps.ts";

/*
 * H.264 in AVC form (length-prefixed NAL units with an avcC description, as WebCodecs and
 * serve-sim give it) rewritten as Annex B, the form device and computer-use live views carry:
 * parameter sets in front of every keyframe, so a decoder can join at any IDR.
 */

export { spsDimensions } from "./h264-sps.ts";

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
  if (record.length < 7 || record[0] !== 1) throw new Error("H.264 description invalid");
  const codec = `avc1.${record.subarray(1, 4).toString("hex").toUpperCase()}`;
  const lengthSize = ((record[4] ?? 0) & 3) + 1;
  if (lengthSize === 3) throw new Error("H.264 NAL length size invalid");
  const sets: Buffer[] = [];
  let sps: Buffer | undefined;
  let offset = 5;
  for (const kind of ["sps", "pps"] as const) {
    const mask = kind === "sps" ? 31 : 255;
    const count = (record[offset++] ?? 0) & mask;
    for (let index = 0; index < count; index++) {
      if (offset + 2 > record.length) throw new Error("H.264 description truncated");
      const length = record.readUInt16BE(offset);
      const nal = record.subarray(offset + 2, offset + 2 + length);
      if (!length || nal.length !== length) throw new Error("H.264 description truncated");
      offset += 2 + length;
      if (kind === "sps") sps ??= nal;
      sets.push(startCode, nal);
    }
  }
  if (!sps) throw new Error("H.264 description has no SPS");
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
    if (!length || offset > sample.length) throw new Error("H.264 sample is truncated");
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
