import type { Frame } from "./frames.ts";

/** Bounded FIFO of complete access units. A missing delta invalidates the rest of its GOP. */
export class RecordingQueue {
  readonly gaps: { first: number; last: number }[] = [];
  readonly #frames = new Map<number, Frame>();
  readonly #limit: number;
  #head = 0;
  #tail = 0;
  #bytes = 0;
  #dropping = false;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid queue limit");
    this.#limit = limit;
  }
  push(frame: Frame): void {
    const key = frame.header.codec === "jpeg" || frame.header.keyframe === true;
    const fits = this.#bytes + frame.packet.length <= this.#limit;
    if (this.#dropping && key && fits) this.#dropping = false;
    if (this.#dropping || !fits) {
      if (!this.#dropping)
        this.gaps.push({ first: frame.header.sequence, last: frame.header.sequence });
      const gap = this.gaps.at(-1);
      if (gap) gap.last = frame.header.sequence;
      this.#dropping = true;
      return;
    }
    this.#frames.set(this.#tail++, frame);
    this.#bytes += frame.packet.length;
  }
  next(): Frame | undefined {
    const frame = this.#frames.get(this.#head);
    if (frame) {
      this.#frames.delete(this.#head++);
      this.#bytes -= frame.packet.length;
    }
    return frame;
  }
  clear(): void {
    this.#frames.clear();
    this.#head = this.#tail;
    this.#bytes = 0;
  }
}
