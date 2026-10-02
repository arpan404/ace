/** One fixed allocation; offsets refer to raw PTY bytes, not JS characters. */
export class ByteRing {
  readonly capacity: number;
  #bytes: Buffer;
  end = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 4) {
      throw new RangeError("Scrollback capacity must be a safe integer of at least 4 bytes");
    }
    this.capacity = capacity;
    this.#bytes = Buffer.alloc(capacity);
  }

  get start(): number {
    return Math.max(0, this.end - this.capacity);
  }

  append(bytes: Buffer): void {
    const next = this.end + bytes.length;
    if (!Number.isSafeInteger(next)) throw new RangeError("Terminal byte offset overflow");
    const retained = bytes.subarray(Math.max(0, bytes.length - this.capacity));
    const at = (next - retained.length) % this.capacity;
    const first = Math.min(retained.length, this.capacity - at);
    retained.copy(this.#bytes, at, 0, first);
    retained.copy(this.#bytes, 0, first);
    this.end = next;
  }

  byte(offset: number): number {
    return this.#bytes[offset % this.capacity]!;
  }

  alignStart(offset: number): number {
    while (offset < this.end && (this.byte(offset) & 0xc0) === 0x80) offset++;
    return offset;
  }

  /** Withhold a partial final character, including across native read boundaries. */
  completeEnd(start: number, limit: number): number {
    if (limit <= start) return limit;
    let lead = limit - 1;
    while (lead > start && (this.byte(lead) & 0xc0) === 0x80) lead--;
    const value = this.byte(lead);
    const width =
      value >= 0xf0 && value <= 0xf4
        ? 4
        : value >= 0xe0 && value <= 0xef
          ? 3
          : value >= 0xc2 && value <= 0xdf
            ? 2
            : 1;
    return limit - lead < width ? lead : limit;
  }

  read(start: number, end = this.end): Buffer {
    const bytes = Buffer.alloc(end - start);
    const at = start % this.capacity;
    const first = Math.min(bytes.length, this.capacity - at);
    this.#bytes.copy(bytes, 0, at, at + first);
    this.#bytes.copy(bytes, first, 0, bytes.length - first);
    return bytes;
  }
}
