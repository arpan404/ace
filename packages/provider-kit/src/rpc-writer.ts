import type { Writable } from "node:stream";
import { byteLimit } from "./output-budget.ts";

type Write = {
  line: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** A bounded FIFO; only one write is handed to stdin until callback and drain. */
export class RpcWriter {
  readonly #stream: Writable;
  readonly #maxQueuedBytes: number;
  readonly #queue = new Map<number, Write>();
  #next = 0;
  #bytes = 0;
  #active: Write | undefined;
  #blocked = false;
  #closed: Error | undefined;

  constructor(stream: Writable, maxQueuedBytes: number) {
    this.#stream = stream;
    this.#maxQueuedBytes = byteLimit(maxQueuedBytes, "maxQueuedBytes");
    stream.on("drain", this.#drain);
    stream.once("close", this.#ended);
    stream.once("error", this.#failed);
  }

  send(line: string, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(new Error("JSON-RPC write cancelled"));
    const bytes = Buffer.byteLength(line);
    if (this.#bytes + bytes > this.#maxQueuedBytes)
      return Promise.reject(new Error("JSON-RPC write queue exceeded limit"));
    return new Promise<void>((resolve, reject) => {
      const id = this.#next++;
      const abort = () => {
        if (this.#queue.delete(id)) this.#bytes -= write.bytes;
        // Active bytes remain charged until the callback, even after peer disposal.
        write.cleanup();
        write.reject(
          signal?.reason instanceof Error ? signal.reason : new Error("JSON-RPC write cancelled"),
        );
        write.resolve = () => {};
        write.reject = () => {};
      };
      const write: Write = {
        line,
        bytes,
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener("abort", abort);
          write.cleanup = () => {};
        },
      };
      this.#queue.set(id, write);
      this.#bytes += bytes;
      signal?.addEventListener("abort", abort, { once: true });
      this.#pump();
    });
  }

  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#stream.removeListener("drain", this.#drain);
    this.#stream.removeListener("close", this.#ended);
    this.#stream.removeListener("error", this.#failed);
    if (this.#active) {
      this.#active.cleanup();
      this.#active.reject(error);
      this.#active.resolve = () => {};
      this.#active.reject = () => {};
    }
    for (const write of this.#queue.values()) {
      write.cleanup();
      write.reject(error);
      this.#bytes -= write.bytes;
    }
    this.#queue.clear();
  }

  #ended = (): void => {
    this.close(new Error("JSON-RPC stdin closed"));
  };
  #failed = (error: Error): void => {
    this.close(error);
  };

  #drain = (): void => {
    this.#blocked = false;
    this.#pump();
  };
  #pump(): void {
    if (this.#closed || this.#active || this.#blocked) return;
    const entry = this.#queue.entries().next();
    if (entry.done) return;
    const [id, write] = entry.value;
    this.#queue.delete(id);
    this.#active = write;
    try {
      this.#blocked = !this.#stream.write(write.line, (error) => {
        write.cleanup();
        this.#bytes -= write.bytes;
        this.#active = undefined;
        if (error) write.reject(error);
        else write.resolve();
        this.#pump();
      });
    } catch (error) {
      write.cleanup();
      this.#bytes -= write.bytes;
      this.#active = undefined;
      write.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pump();
    }
  }
}
