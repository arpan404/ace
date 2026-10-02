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
  readonly #maxMessageBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #queue = new Map<number, Write>();
  #next = 0;
  #bytes = 0;
  #active: Write | undefined;
  #blocked = false;
  #closed: Error | undefined;

  constructor(stream: Writable, limits: { maxMessageBytes?: number; maxQueuedBytes?: number }) {
    this.#stream = stream;
    this.#maxMessageBytes = byteLimit(
      limits.maxMessageBytes ?? 16 * 1024 * 1024,
      "maxMessageBytes",
    );
    this.#maxQueuedBytes = byteLimit(limits.maxQueuedBytes ?? 32 * 1024 * 1024, "maxQueuedBytes");
    stream.on("drain", this.#drain);
  }

  send(line: string, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(new Error("JSON-RPC write cancelled"));
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#maxMessageBytes)
      return Promise.reject(new Error("JSON-RPC message exceeded limit"));
    if (this.#bytes + bytes > this.#maxQueuedBytes)
      return Promise.reject(new Error("JSON-RPC write queue exceeded limit"));
    return new Promise<void>((resolve, reject) => {
      const id = this.#next++;
      const abort = () => {
        const write = this.#queue.get(id);
        if (!write) return; // In-flight bytes remain charged until the write callback.
        this.#queue.delete(id);
        this.#bytes -= write.bytes;
        write.cleanup();
        reject(new Error("JSON-RPC write cancelled"));
      };
      this.#queue.set(id, {
        line,
        bytes,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      this.#bytes += bytes;
      signal?.addEventListener("abort", abort, { once: true });
      this.#pump();
    });
  }

  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#stream.removeListener("drain", this.#drain);
    if (this.#active) {
      this.#active.cleanup();
      this.#active.reject(error);
      this.#active = undefined;
    }
    for (const write of this.#queue.values()) {
      write.cleanup();
      write.reject(error);
    }
    this.#queue.clear();
  }

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
    write.cleanup();
    this.#active = write;
    try {
      this.#blocked = !this.#stream.write(write.line, (error) => {
        this.#bytes -= write.bytes;
        this.#active = undefined;
        if (error) write.reject(error);
        else write.resolve();
        this.#pump();
      });
    } catch (error) {
      this.#bytes -= write.bytes;
      this.#active = undefined;
      write.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pump();
    }
  }
}
