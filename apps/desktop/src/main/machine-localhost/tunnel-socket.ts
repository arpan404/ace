import { Duplex } from "node:stream";
import type { TunnelStream } from "./tunnel-contract.ts";

/**
 * A tunnel stream as the socket Node's HTTP client sends a request on, so plain-HTTP requests
 * to the machine's localhost keep their connections alive across requests (`http.Agent`), one
 * stream per connection, as a browser's would. Backpressure holds both ways: a write completes
 * once the tunnel admits it, and the stream is read only as Node asks for more. Both sides ending
 * closes it quietly; anything else (a destroy before both ended, a reset from the machine) resets
 * the stream. `setTimeout` is the idle timer the agent uses to drop a kept connection.
 */
export class TunnelSocket extends Duplex {
  #stream: TunnelStream;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #reading = false;
  #idleMs = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;

  constructor(stream: TunnelStream) {
    super({ allowHalfOpen: true });
    this.#stream = stream;
    this.#reader = stream.readable.getReader();
  }

  /** The idle timeout set now, as `net.Socket` reports it. */
  get timeout(): number {
    return this.#idleMs;
  }

  override _read(): void {
    this.#pull();
  }

  #pull(): void {
    if (this.#reading) return;
    this.#reading = true;
    this.#reader.read().then(
      ({ done, value }) => {
        this.#reading = false;
        if (this.destroyed) return;
        this.#active();
        if (done) this.push(null);
        else if (this.push(value)) this.#pull();
      },
      (error: unknown) => {
        this.#reading = false;
        this.destroy(error instanceof Error ? error : new Error("Tunnel stream reset"));
      },
    );
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#active();
    this.#stream
      .write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      .then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#stream.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#idle);
    if (!(this.readableEnded && this.writableFinished)) this.#stream.reset();
    this.#reader.cancel().catch(() => {});
    callback(error);
  }

  setTimeout(ms: number, callback?: () => void): this {
    if (callback) {
      if (ms > 0) this.once("timeout", callback);
      else this.off("timeout", callback);
    }
    this.#idleMs = ms;
    this.#active();
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  #active(): void {
    clearTimeout(this.#idle);
    this.#idle =
      this.#idleMs > 0 && !this.destroyed
        ? setTimeout(() => this.emit("timeout"), this.#idleMs)
        : undefined;
  }
}
