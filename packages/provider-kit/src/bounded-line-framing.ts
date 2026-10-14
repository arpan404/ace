export type DroppedOutputLine = {
  bytes: number;
  prefix: string;
  /** A split line reports loss immediately, then its final byte count at the delimiter. */
  phase: "start" | "end" | "complete";
};
type FramedBytes = { type: "data"; bytes: Buffer } | { type: "drop"; line: DroppedOutputLine };

/** Stateful byte framing without I/O. An oversized line retains only a bounded prefix. */
export class BoundedLineFraming {
  readonly #limit: number;
  #parts: Buffer[] = [];
  #bytes = 0;
  #prefix: string | undefined;
  #announced = false;
  constructor(limit: number) {
    this.#limit = limit;
  }
  next(chunk: Buffer): FramedBytes[] {
    const frames: FramedBytes[] = [];
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      const delimiter = end < chunk.length && (chunk[end] === 10 || chunk[end] === 13);
      if (!delimiter && end !== chunk.length) continue;
      const size = end - start;
      this.#bytes += size;
      if (this.#prefix === undefined) {
        // Copy: a short tail must not retain the provider's entire input chunk.
        const remaining = Math.max(0, this.#limit - (this.#bytes - size));
        if (size)
          this.#parts.push(Buffer.from(chunk.subarray(start, start + Math.min(size, remaining))));
        if (this.#bytes > this.#limit) {
          this.#prefix = Buffer.concat(this.#parts, Math.min(this.#limit, 4096)).toString("utf8");
          this.#parts = [];
          if (!delimiter) {
            this.#announced = true;
            frames.push({
              type: "drop",
              line: { bytes: this.#bytes, prefix: this.#prefix, phase: "start" },
            });
          }
        }
      }
      if (delimiter) {
        const skipped = this.#prefix !== undefined;
        frames.push(...this.finish());
        // A dropped line contributes no delimiter. CRLF's following LF is harmless framing.
        if (!skipped)
          frames.push({ type: "data", bytes: Buffer.from(chunk.subarray(end, end + 1)) });
      }
      start = end + 1;
    }
    return frames;
  }
  finish(): FramedBytes[] {
    const frames: FramedBytes[] =
      this.#prefix !== undefined
        ? [
            {
              type: "drop",
              line: {
                bytes: this.#bytes,
                prefix: this.#prefix,
                phase: this.#announced ? "end" : "complete",
              },
            },
          ]
        : this.#parts.length
          ? [{ type: "data", bytes: Buffer.concat(this.#parts) }]
          : [];
    this.#parts = [];
    this.#bytes = 0;
    this.#prefix = undefined;
    this.#announced = false;
    return frames;
  }
}
