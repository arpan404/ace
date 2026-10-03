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
      const { width, height } = dimensions(image);
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
function dimensions(image: Buffer): { width: number; height: number } {
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
