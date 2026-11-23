// SPDX-License-Identifier: Apache-2.0
/** The JSON-RPC halves the addon owns: id reservations, the writer queue and
 * envelope classification. Encodings stay in `jsonrpc.ts`'s `JSON.stringify`, so
 * `toJSON` keys, value identity and the observer's envelope are today's. */

import type { Writable } from "node:stream";
import { asError, type RpcIdValue, streams } from "./native-stream-addon.ts";

/** `RpcIds` over the native reservations; one handle per pipe, held by `rpc-owner`. */
export class NativeRpcIds {
  readonly #handle: { reserve(explicitJson?: string): string };

  constructor(maxExplicit: number) {
    this.#handle = new (streams().RpcIdsNative)(maxExplicit);
  }

  reserve(id?: RpcIdValue): RpcIdValue {
    const text = this.#handle.reserve(id === undefined ? undefined : JSON.stringify(id));
    const value: unknown = JSON.parse(text);
    if (typeof value === "string" || typeof value === "number") return value;
    throw new Error("Invalid request id");
  }
}

interface NativeWrite {
  line: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * `RpcWriter` over the native bounded FIFO. One write is handed to stdin at a
 * time; the queue's byte bound, the active charge and the cancellation rules are
 * `jsonrpc.rs`'s, the writes themselves are this stream's.
 */
export class NativeRpcWriter {
  readonly #queue: ReturnType<typeof nativeWriterQueue>;
  readonly #stream: Writable;
  readonly #writes = new Map<number, NativeWrite>();
  #closed: Error | undefined;

  constructor(stream: Writable, maxQueuedBytes: number) {
    this.#stream = stream;
    this.#queue = nativeWriterQueue(maxQueuedBytes);
    stream.on("drain", this.#drain);
    stream.once("close", this.#ended);
    stream.once("error", this.#failed);
  }

  send(line: string, bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(new Error("JSON-RPC write cancelled"));
    let ticket: number;
    try {
      ticket = this.#queue.enqueue(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      const write: NativeWrite = {
        line,
        bytes,
        resolve,
        reject,
        cleanup: () => {},
      };
      const abort = () => {
        const queued = this.#queue.cancel(ticket);
        if (queued) this.#writes.delete(ticket);
        write.cleanup();
        write.reject(
          signal?.reason instanceof Error ? signal.reason : new Error("JSON-RPC write cancelled"),
        );
        write.resolve = () => {};
        write.reject = () => {};
      };
      write.cleanup = () => {
        signal?.removeEventListener("abort", abort);
        write.cleanup = () => {};
      };
      this.#writes.set(ticket, write);
      signal?.addEventListener("abort", abort, { once: true });
      this.#pump();
    });
  }

  close(error: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    this.#stream.removeListener("drain", this.#drain);
    this.#stream.removeListener("close", this.#ended);
    this.#stream.removeListener("error", this.#failed);
    const active = this.#queue.active();
    const queued = this.#queue.close();
    if (active != null) {
      const write = this.#writes.get(active);
      if (write !== undefined) {
        write.cleanup();
        write.reject(error);
        write.resolve = () => {};
        write.reject = () => {};
      }
    }
    for (const ticket of queued) {
      const write = this.#writes.get(ticket);
      if (write === undefined) continue;
      write.cleanup();
      write.reject(error);
      this.#writes.delete(ticket);
    }
  }

  #drain = (): void => {
    this.#queue.setBlocked(false);
    this.#pump();
  };
  #ended = (): void => {
    this.close(new Error("JSON-RPC stdin closed"));
  };
  #failed = (error: Error): void => {
    this.close(error);
  };
  #pump(): void {
    while (this.#closed === undefined) {
      const ticket = this.#queue.claim();
      if (ticket == null) return;
      const write = this.#writes.get(ticket);
      if (write === undefined) {
        this.#queue.written(ticket);
        continue;
      }
      let blocked: boolean;
      try {
        blocked = !this.#stream.write(write.line, (error?: Error | null) => {
          this.#queue.written(ticket);
          this.#writes.delete(ticket);
          write.cleanup();
          if (error) write.reject(error);
          else write.resolve();
          this.#pump();
        });
      } catch (error) {
        this.#queue.written(ticket);
        this.#writes.delete(ticket);
        write.cleanup();
        write.reject(asError(error));
        continue;
      }
      this.#queue.setBlocked(blocked);
    }
  }
}

function nativeWriterQueue(maxQueuedBytes: number) {
  return new (streams().WriterQueueNative)(maxQueuedBytes);
}

/** What one received line is, with the fields the peer reads, as today's parse. */
export type NativeInspected =
  | { kind: "unparsable"; raw: undefined }
  | { kind: "malformed"; raw: unknown }
  | { kind: "request"; raw: unknown; id: RpcIdValue; method: string; params: unknown }
  | { kind: "notification"; raw: unknown; method: string; params: unknown }
  | { kind: "response"; raw: unknown; id: RpcIdValue; result: unknown; error: string | undefined };

function isId(value: unknown): value is RpcIdValue {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Classify a received line natively, then parse it once for the message and its
 * fields. Nothing is decoded twice: the observer and the peer share this object.
 */
export function nativeInspect(line: string): NativeInspected {
  const kind = streams().rpcInspect(line);
  if (kind === "unparsable") return { kind: "unparsable", raw: undefined };
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { kind: "malformed", raw };
  if (kind === "malformed") return { kind: "malformed", raw };
  const message = raw as Record<string, unknown>;
  const id = message["id"];
  const method = message["method"];
  if (kind === "request") {
    if (!isId(id) || typeof method !== "string") return { kind: "malformed", raw };
    return { kind: "request", raw, id, method, params: message["params"] };
  }
  if (kind === "notification") {
    if (typeof method !== "string") return { kind: "malformed", raw };
    return { kind: "notification", raw, method, params: message["params"] };
  }
  if (!isId(id)) return { kind: "malformed", raw };
  const error = message["error"];
  return {
    kind: "response",
    raw,
    id,
    result: message["result"],
    error: error === undefined ? undefined : JSON.stringify(error),
  };
}

/** `rpcErrorCode`'s native half. */
export function nativeRpcErrorCode(message: string): number | undefined {
  return streams().rpcErrorCode(message) ?? undefined;
}
