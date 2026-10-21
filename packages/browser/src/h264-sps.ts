/**
 * Coded picture size from an H.264 sequence parameter set (ITU-T H.264 §7.3.2.1.1), after
 * frame cropping. Only the fields that precede the size are read; everything after is ignored.
 */
export function spsDimensions(nal: Uint8Array): { width: number; height: number } {
  const bits = new BitReader(unescape(nal.subarray(1)));
  const profile = bits.read(8);
  bits.read(16); // constraint flags and level
  bits.ue(); // seq_parameter_set_id
  let chroma = 1;
  if (highProfiles.has(profile)) {
    chroma = bits.ue();
    if (chroma > 3) throw new Error("Invalid H.264 chroma format");
    if (chroma === 3 && bits.read(1)) chroma = 0; // separate colour planes crop like 4:0:0
    bits.ue(); // bit_depth_luma_minus8
    bits.ue(); // bit_depth_chroma_minus8
    bits.read(1); // qpprime_y_zero_transform_bypass_flag
    if (bits.read(1)) {
      const lists = chroma === 3 ? 12 : 8;
      for (let list = 0; list < lists; list++)
        if (bits.read(1)) skipScalingList(bits, list < 6 ? 16 : 64);
    }
  }
  bits.ue(); // log2_max_frame_num_minus4
  const order = bits.ue();
  if (order === 0) bits.ue();
  else if (order === 1) {
    bits.read(1);
    bits.se();
    bits.se();
    const cycle = bits.ue();
    if (cycle > 255) throw new Error("Invalid H.264 picture order cycle");
    for (let index = 0; index < cycle; index++) bits.se();
  } else if (order !== 2) throw new Error("Invalid H.264 picture order type");
  bits.ue(); // max_num_ref_frames
  bits.read(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = bits.ue() + 1;
  const heightUnits = bits.ue() + 1;
  const frameOnly = bits.read(1);
  if (!frameOnly) bits.read(1); // mb_adaptive_frame_field_flag
  bits.read(1); // direct_8x8_inference_flag
  let width = widthMbs * 16;
  let height = (2 - frameOnly) * heightUnits * 16;
  if (bits.read(1)) {
    const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
    const [left, right, top, bottom] = [bits.ue(), bits.ue(), bits.ue(), bits.ue()];
    width -= cropX * (left + right);
    height -= cropY * (top + bottom);
  }
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
    throw new Error("Invalid H.264 picture size");
  return { width, height };
}

const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(bits: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let index = 0; index < size; index++) {
    if (next !== 0) next = (last + bits.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Remove emulation-prevention bytes (00 00 03 → 00 00) so the RBSP can be read as bits. */
function unescape(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  let length = 0;
  let zeros = 0;
  for (const byte of source) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

class BitReader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) {
      const byte = this.bytes[this.offset >> 3];
      if (byte === undefined) throw new Error("Truncated H.264 parameter set");
      value = value * 2 + ((byte >> (7 - (this.offset & 7))) & 1);
      this.offset++;
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (this.read(1) === 0) if (++zeros > 31) throw new Error("Invalid H.264 Exp-Golomb code");
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se(): number {
    const value = this.ue();
    return value % 2 ? (value + 1) / 2 : -value / 2;
  }
}
