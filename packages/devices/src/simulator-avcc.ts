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

export { annexB, avcConfig, type AvcConfig } from "@ace/browser/h264";
