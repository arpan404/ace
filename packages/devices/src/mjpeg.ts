import { jpegDimensions } from "./jpeg.ts";

/** Bounded multipart decoding: allocate one advertised frame, never repeatedly join image chunks. */
export class MjpegDecoder {
  private readonly header = Buffer.alloc(4096);
  private headerBytes = 0;
  private image: Buffer | undefined;
  private imageBytes = 0;
  private frame = 0;
  private readonly boundary: string;
  private begun = 0;
  private readonly emit: (image: Buffer, width: number, height: number, frame: number) => void;
  /** `emit` gets each image with its number: the value `started` took when it began arriving. */
  constructor(
    boundary: string,
    emit: (image: Buffer, width: number, height: number, frame: number) => void,
  ) {
    if (!/^[A-Za-z0-9_-]{1,70}$/.test(boundary))
      throw new Error("Invalid Simulator multipart boundary");
    this.boundary = boundary;
    this.emit = emit;
  }
  /** How many frames have begun arriving: the count rises at the first byte of a part header. */
  get started(): number {
    return this.begun;
  }
  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      if (!this.image) {
        if (this.headerBytes === this.header.length)
          throw new Error("Simulator JPEG headers exceed limit");
        const byte = chunk.readUInt8(at++);
        // The line break closing the last image belongs to it, not to the next frame.
        if (this.headerBytes === 0) {
          if (byte === 0x0d || byte === 0x0a) continue;
          this.begun++;
        }
        this.header[this.headerBytes++] = byte;
        if (this.headerBytes < 4 || this.header.readUInt32BE(this.headerBytes - 4) !== 0x0d0a0d0a)
          continue;
        const lines = this.header
          .subarray(0, this.headerBytes)
          .toString("ascii")
          .trim()
          .split("\r\n");
        if (lines.shift() !== `--${this.boundary}`)
          throw new Error("Invalid Simulator frame boundary");
        const length = lines
          .find((line) => /^content-length:/i.test(line))
          ?.split(":")[1]
          ?.trim();
        if (!length || !/^\d{1,8}$/.test(length) || Number(length) < 2 || Number(length) > 8388608)
          throw new Error("Simulator JPEG size exceeds limit");
        if (!lines.some((line) => /^content-type:\s*image\/jpeg$/i.test(line)))
          throw new Error("Invalid Simulator frame content type");
        this.image = Buffer.allocUnsafe(Number(length));
        this.imageBytes = 0;
        this.headerBytes = 0;
        this.frame = this.begun;
      }
      const image = this.image;
      const take = Math.min(image.length - this.imageBytes, chunk.length - at);
      chunk.copy(image, this.imageBytes, at, at + take);
      this.imageBytes += take;
      at += take;
      if (this.imageBytes === image.length) {
        this.image = undefined;
        this.imageBytes = 0;
        const { width, height } = jpegDimensions(image);
        this.emit(image, width, height, this.frame);
      }
    }
  }
}
