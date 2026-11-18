import type { FilesClock } from "./host.ts";
import { FilesRequestError, type FilesResult } from "./errors.ts";
import type { Op, Reply } from "./schemas.ts";
import { encodeBody, encodeMessage, FilesWireError } from "./wire.ts";

type Pending = {
  resolve: (result: FilesResult) => void;
  reject: (error: Error) => void;
  stopTimer: () => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  /** Runs synchronously as the response arrives, before the promise resolves. */
  onReply: ((reply: Reply) => void) | undefined;
  /** Set once the response says a body follows. */
  reply: Reply | undefined;
  /** A body that arrived before the response naming it. */
  body: Uint8Array | undefined;
  /** The op this request sent, so an error can say which one the binary did not know. */
  op: Op["op"];
};

/**
 * Requests in flight: ids, per-request timeouts, cancellation, and pairing a response with the
 * body frame that belongs to it. The process decides whether a run is alive; this class only
 * writes frames and settles promises.
 */
export class PendingRequests {
  readonly #clock: FilesClock;
  readonly #write: (bytes: Uint8Array) => void;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(clock: FilesClock, write: (bytes: Uint8Array) => void) {
    this.#clock = clock;
    this.#write = write;
  }

  /** Send one request, and its body when it has one. Rejects with `CANCELLED` when aborted. */
  send(
    op: Op,
    timeoutMs: number,
    options: {
      body?: Uint8Array | undefined;
      signal?: AbortSignal | undefined;
      /** Runs synchronously inside the response frame, so same-chunk events find their book. */
      onReply?: ((reply: Reply) => void) | undefined;
    } = {},
  ): Promise<FilesResult> {
    if (options.signal?.aborted)
      return Promise.reject(
        new FilesRequestError("CANCELLED", "the request was cancelled before it was sent"),
      );
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id))
      return Promise.reject(
        new FilesRequestError("INVALID_ARGUMENT", "the request id space is exhausted"),
      );
    let frames: Uint8Array[];
    try {
      frames = [encodeMessage({ type: "request", id, op })];
      if (options.body) frames.push(encodeBody(id, options.body));
    } catch (error) {
      return Promise.reject(
        new FilesRequestError(
          error instanceof FilesWireError ? error.code : "INVALID_ARGUMENT",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const stopTimer = this.#clock.setTimeout(
        () =>
          this.#cancel(
            id,
            "TIMEOUT",
            `ace-files did not answer request ${id} within ${timeoutMs} ms`,
          ),
        timeoutMs,
      );
      let onAbort: (() => void) | undefined;
      if (options.signal) {
        onAbort = () => this.#cancel(id, "CANCELLED", `request ${id} was cancelled`);
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve,
        reject,
        stopTimer,
        signal: options.signal,
        onAbort,
        onReply: options.onReply,
        reply: undefined,
        body: undefined,
        op: op.op,
      });
      for (const frame of frames) this.#write(frame);
    });
  }

  /** A response; a `read` with `body: true` waits for its body frame. */
  acceptResponse(id: number, reply: Reply): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    pending.onReply?.(reply);
    if (reply.type === "read" && reply.body && pending.body === undefined) {
      pending.reply = reply;
      return;
    }
    const body = reply.type === "read" ? (pending.body ?? new Uint8Array(0)) : new Uint8Array(0);
    this.#finish(id, { result: { reply, body } });
  }

  /** A body frame, wherever it lands relative to its response. */
  acceptBody(id: number, bytes: Uint8Array): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (!pending.reply) {
      pending.body = bytes;
      return;
    }
    if (pending.reply.type !== "read" || !pending.reply.body) return;
    this.#finish(id, { result: { reply: pending.reply, body: bytes } });
  }

  /**
   * An `error` message, which fails its request and keeps the stream alive. `explain`, when the
   * process supplies one, annotates the message with the op it was for.
   */
  acceptError(
    id: number,
    code: string,
    message: string,
    current?: string,
    explain?: (op: Op["op"]) => string | undefined,
  ): void {
    const pending = this.#pending.get(id);
    const detail = pending === undefined ? undefined : explain?.(pending.op);
    this.#finish(id, {
      error: new FilesRequestError(
        code,
        detail === undefined ? message : `${message}: ${detail}`,
        current,
      ),
    });
  }

  /** Fail everything in flight, for a process that exited or a supervisor shutting down. */
  failAll(error: Error): void {
    for (const id of Array.from(this.#pending.keys())) this.#finish(id, { error });
  }

  #cancel(id: number, code: string, message: string): void {
    if (!this.#pending.has(id)) return;
    this.#finish(id, { error: new FilesRequestError(code, message) });
    try {
      this.#write(encodeMessage({ type: "cancel", id }));
    } catch {
      // The run is gone; its exit fails the request anyway.
    }
  }

  #finish(id: number, outcome: { result: FilesResult } | { error: Error }): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.stopTimer();
    if (pending.signal && pending.onAbort)
      pending.signal.removeEventListener("abort", pending.onAbort);
    if ("error" in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.result);
  }
}
