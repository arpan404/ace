/** One fixed allocation; offsets refer to raw PTY bytes, not JS characters. */
export class ByteRing {
  readonly capacity: number;
  #bytes: Buffer;
  #prefix = Buffer.alloc(3);
  #prefixStart = 0;
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
    const oldest = Math.max(0, next - this.capacity);
    const oldestByte = oldest >= this.end ? bytes[oldest - this.end] : this.byte(oldest);
    const prefixStart =
      ((oldestByte ?? 0) & 0xc0) === 0x80 ? Math.max(this.#prefixStart, oldest - 3) : oldest;
    // Preserve enough evicted context to distinguish a valid character interior
    // from standalone malformed continuation bytes at the ring's oldest edge.
    for (let offset = prefixStart; offset < oldest; offset++)
      this.#prefix[offset - prefixStart] =
        offset >= this.end ? (bytes[offset - this.end] ?? 0) : this.byte(offset);
    this.#prefixStart = prefixStart;
    const retained = bytes.subarray(Math.max(0, bytes.length - this.capacity));
    const at = (next - retained.length) % this.capacity;
    const first = Math.min(retained.length, this.capacity - at);
    retained.copy(this.#bytes, at, 0, first);
    retained.copy(this.#bytes, 0, first);
    this.end = next;
  }

  byte(offset: number): number {
    const value =
      offset < this.start
        ? this.#prefix[offset - this.#prefixStart]
        : this.#bytes[offset % this.capacity];
    if (value === undefined) throw new RangeError("Invalid ring byte offset");
    return value;
  }

  alignStart(offset: number, exited: boolean): number | undefined {
    for (let lead = offset - 1; lead >= Math.max(this.#prefixStart, offset - 3); lead--) {
      const width = this.#width(lead, this.end);
      if (width > 1 && lead + width > offset) {
        if (lead + width > this.end) return exited ? offset : undefined;
        return lead + width;
      }
    }
    return offset;
  }

  /** Withhold a partial final character, including across native read boundaries. */
  completeEnd(start: number, limit: number): number {
    if (limit <= start) return limit;
    let lead = limit - 1;
    while (lead > start && lead > limit - 4 && (this.byte(lead) & 0xc0) === 0x80) lead--;
    const width = this.#width(lead, limit);
    return limit - lead < width ? lead : limit;
  }

  #width(lead: number, limit: number): number {
    const value = this.byte(lead);
    const width =
      value >= 0xf0 && value <= 0xf4
        ? 4
        : value >= 0xe0 && value <= 0xef
          ? 3
          : value >= 0xc2 && value <= 0xdf
            ? 2
            : 1;
    for (let at = lead + 1; at < Math.min(lead + width, limit); at++) {
      const byte = this.byte(at);
      if ((byte & 0xc0) !== 0x80) return 1;
      if (
        at === lead + 1 &&
        ((value === 0xe0 && byte < 0xa0) ||
          (value === 0xed && byte > 0x9f) ||
          (value === 0xf0 && byte < 0x90) ||
          (value === 0xf4 && byte > 0x8f))
      )
        return 1;
    }
    return width;
  }

  release(): void {
    this.#bytes = Buffer.alloc(0);
    this.#prefix = Buffer.alloc(0);
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
