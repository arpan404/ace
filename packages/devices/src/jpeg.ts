import { DeviceError } from "./sdk.ts";
const MAX_FRAME = 8 * 1024 * 1024;
const endMarker = Buffer.from([255, 217]);
/** Bounded geometric accumulation; emitted bytes are borrowed until emit returns. */
export class JpegDecoder {
  private buffer = Buffer.allocUnsafe(65536);
  private size = 0;
  private previous = 0;
  private readonly emit: (image: Buffer, width: number, height: number) => void;
  constructor(emit: (image: Buffer, width: number, height: number) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    let start = 0;
    let end = this.previous === 255 && chunk[0] === 217 ? 1 : 0;
    while (start < chunk.length) {
      if (!end) {
        const found = chunk.indexOf(endMarker, start);
        if (found < 0) break;
        end = found + 2;
      }
      this.append(chunk.subarray(start, end));
      const image = this.buffer.subarray(0, this.size);
      this.size = 0;
      const { width, height } = jpegDimensions(image);
      this.emit(image, width, height);
      start = end;
      end = 0;
    }
    this.append(chunk.subarray(start));
    this.previous = chunk.at(-1) ?? this.previous;
  }
  private append(chunk: Buffer): void {
    const next = this.size + chunk.length;
    if (next > MAX_FRAME)
      throw new DeviceError("limit", "Android JPEG exceeds 8 MiB", "Reduce emulator resolution.");
    if (next > this.buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(MAX_FRAME, Math.max(next, this.buffer.length * 2)));
      this.buffer.copy(grown, 0, 0, this.size);
      this.buffer = grown;
    }
    chunk.copy(this.buffer, this.size);
    this.size = next;
  }
}
export function jpegDimensions(image: Buffer): { width: number; height: number } {
  if (image.readUInt16BE(0) !== 0xffd8) throw new Error("Invalid JPEG start");
  for (let at = 2; at + 4 <= image.length;) {
    if (image[at] !== 255) throw new Error("Invalid JPEG marker");
    const marker = image[at + 1];
    if (marker === 255) {
      at++;
      continue;
    }
    const length = image.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > image.length) throw new Error("Invalid JPEG segment");
    if (marker === 192 || marker === 194) {
      if (length < 8) throw new Error("Invalid JPEG dimensions");
      return { width: image.readUInt16BE(at + 7), height: image.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  throw new Error("Missing JPEG dimensions");
}

/**
 * Whether a JPEG is whole: every segment fits, a frame header comes before the first scan, and
 * the last scan's data runs up to the end-of-image marker that closes the bytes. A picture cut
 * short anywhere fails, which Bun's decoder would otherwise fill with grey. It reads markers
 * only, never the coded data, so a scan damaged inside while its end marker survives (cut and
 * then closed with a fresh end marker) still passes; only a strict decoder could tell.
 */
export function jpegComplete(image: Uint8Array): boolean {
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) return false;
  let frame = false;
  let scans = 0;
  let at = 2;
  while (at + 1 < image.length) {
    if (image[at] !== 0xff) return false;
    const marker = image[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) return scans > 0 && at + 2 === image.length;
    if (at + 4 > image.length) return false;
    const length = ((image[at + 2] ?? 0) << 8) | (image[at + 3] ?? 0);
    if (length < 2 || at + 2 + length > image.length) return false;
    // Frame headers: baseline, extended, progressive and lossless, Huffman or arithmetic.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      frame = true;
    at += 2 + length;
    if (marker !== 0xda) continue;
    if (!frame) return false;
    scans++;
    // Coded data ends at the first marker that is neither a stuffed 0xFF nor a restart.
    for (;;) {
      at = image.indexOf(0xff, at);
      if (at < 0 || at + 1 >= image.length) return false;
      const next = image[at + 1] ?? 0;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
      else if (next === 0xff) at++;
      else break;
    }
  }
  return false;
}
