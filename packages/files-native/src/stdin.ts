import type { FilesSink } from "./host.ts";

/**
 * Frames for one child's stdin. A write that reports backpressure parks every later frame until
 * the sink drains, so a child that stops reading never makes the daemon buffer without bound
 * without knowing: the owner can ask `queuedBytes` and refuse more work.
 */
export class StdinQueue {
  readonly #sink: FilesSink;
  readonly #onError: ((error: unknown) => void) | undefined;
  #blocked = false;
  #queue: Uint8Array[] = [];
  #bytes = 0;

  constructor(sink: FilesSink, onError?: (error: unknown) => void) {
    this.#sink = sink;
    this.#onError = onError;
    sink.onDrain(() => this.#drain());
  }

  /** Bytes waiting for the child to read, excluding what the OS pipe already holds. */
  get queuedBytes(): number {
    return this.#bytes;
  }

  /** Write now, or hold the frame until the pipe drains. */
  write(bytes: Uint8Array): void {
    if (this.#blocked) {
      this.#queue.push(bytes);
      this.#bytes += bytes.length;
      return;
    }
    if (!this.#raw(bytes)) this.#blocked = true;
  }

  /** Drop what a dead child never read; the frames belong to a process that is gone. */
  discard(): void {
    this.#queue = [];
    this.#bytes = 0;
    this.#blocked = false;
  }

  #raw(bytes: Uint8Array): boolean {
    try {
      return this.#sink.write(bytes);
    } catch (error) {
      this.#onError?.(error);
      return false;
    }
  }

  #drain(): void {
    if (!this.#blocked) return;
    this.#blocked = false;
    while (this.#queue.length > 0) {
      const frame = this.#queue.shift();
      if (!frame) break;
      this.#bytes -= frame.length;
      if (!this.#raw(frame)) {
        this.#blocked = true;
        return;
      }
    }
  }
}
