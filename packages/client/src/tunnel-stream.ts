import type { PreviewSocket } from "@ace/preview/mux";
import { ClientError } from "./errors.ts";

/** A TCP stream to a port on the machine's loopback, carried by its tunnel (ADR 0194). */
export interface TunnelStream {
  /** What the machine side sends; ends when it ends its side (END), errors when it resets. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Resolves once the tunnel has admitted every byte under the stream's credit (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  /** Half-close our side once what was written has gone; the machine side may keep sending. */
  end(): void;
  /** Abort both sides at once. */
  reset(): void;
  /** Resolves once the stream is gone, however it ended. */
  readonly closed: Promise<void>;
}

/** Pieces the mux takes at a time: one window, as `relay-wire.ts`'s `windowSize`. */
const windowSize = 262_144;

const emit = (listeners: (() => void)[]) => {
  for (const listener of listeners) listener();
};

type Pending = { chunk: Uint8Array; resolve(): void; reject(error: Error): void };

/**
 * One stream as the preview mux sees it (a `PreviewSocket`) and as the tunnel's caller does (a
 * `TunnelStream`). The mux pauses the socket while it sends a piece under credit and resumes it
 * when the piece has been admitted; its first resume is the machine's READY. Bytes the machine
 * sends are queued in `readable` and acknowledged to the mux (which returns the credit) only as
 * the reader takes them, so a slow reader holds the machine side back.
 *
 * It decides nothing about the stream's close: it reports what its caller and reader did (an
 * end, a close once both sides ended, an abort) and does what the mux asks. The mux removes the
 * stream with how it left: finished, the reader keeps what it was sent and its end; reset, the
 * reader errors and whatever it had not read yet is discarded.
 */
export function tunnelStream(
  Readable: typeof ReadableStream,
  hooks: { opened(): void; failed(): void },
): { socket: PreviewSocket; stream: TunnelStream } {
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  const endListeners: (() => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const abortListeners: (() => void)[] = [];
  let paused = true;
  let ready = false;
  /** The mux removed the stream; nothing more happens on it. */
  let destroyed = false;
  /** The caller or reader gave up; the mux hears it once, and removes the stream. */
  let aborted = false;
  let incomingEnded = false;
  let endRequested = false;
  let endEmitted = false;
  let closeEmitted = false;
  const queue: Pending[] = [];
  let queuedBytes = 0;
  /** The write whose last piece the mux is sending: admitted at the next resume. */
  let sending: Pending | undefined;
  let offset = 0;
  const acks: (() => void)[] = [];
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unread = 0;
  const { promise: closed, resolve: settle } = Promise.withResolvers<void>();
  const readable = new Readable<Uint8Array>(
    {
      start(controller) {
        control = controller;
      },
      pull() {
        for (const ack of acks.splice(0)) ack();
      },
      cancel() {
        // A reader that gives up wants no more: the stream is aborted, as a closed socket is.
        reset();
      },
    },
    { highWaterMark: windowSize, size: (chunk: Uint8Array | undefined) => chunk?.byteLength ?? 0 },
  );
  const fail = (error: Error) => {
    for (const entry of queue.splice(0)) entry.reject(error);
    sending?.reject(error);
    sending = undefined;
    queuedBytes = 0;
  };
  const pump = () => {
    if (destroyed || aborted || paused || !ready || !deliver) return;
    if (sending) {
      // The mux resumed: the piece it was sending was admitted.
      if (offset >= sending.chunk.byteLength) {
        sending.resolve();
        sending = undefined;
        offset = 0;
      }
    }
    const head = sending ?? queue.shift();
    if (!head) {
      if (endRequested && !endEmitted) {
        endEmitted = true;
        emit(endListeners);
        if (incomingEnded) finish();
      }
      return;
    }
    sending = head;
    const piece = head.chunk.subarray(offset, offset + windowSize);
    offset += piece.byteLength;
    queuedBytes -= piece.byteLength;
    deliver(piece);
    // The mux pauses while it sends a piece; one that didn't takes the next at once.
    pump();
  };
  /** Both sides ended: the mux drops the stream without a reset. */
  const finish = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    emit(closeListeners);
  };
  /**
   * An abort, never a close: after `end()` and after both sides ended too, until the mux has
   * removed the stream, it sends RESET at once and destroys this socket as reset.
   */
  const reset = () => {
    if (destroyed || aborted) return;
    aborted = true;
    emit(abortListeners);
  };
  const socket: PreviewSocket = {
    get readableLength() {
      return queuedBytes;
    },
    get writableLength() {
      return unread;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (!ready && !destroyed) {
        ready = true;
        hooks.opened();
      }
      pump();
    },
    destroy(removal) {
      if (destroyed) return;
      destroyed = true;
      acks.length = 0;
      if (!ready) hooks.failed();
      const error = new ClientError("tunnel_reset", "Tunnel stream reset");
      // A finished stream has nothing waiting; anything that still does was never sent.
      fail(error);
      if (removal === "reset") {
        // Errors the reader after an END too: bytes it had not read are discarded, so a reset
        // never reads as a clean answer.
        try {
          control?.error(error);
        } catch {
          // The reader cancelled first.
        }
      }
      settle();
    },
    end() {
      // The machine side ended (END): the reader sees the end once it has read the rest.
      if (incomingEnded || destroyed) return;
      incomingEnded = true;
      try {
        control?.close();
      } catch {
        // The reader cancelled first.
      }
      if (endEmitted) finish();
    },
    write(bytes, callback) {
      if (destroyed || incomingEnded) return;
      unread += bytes.byteLength;
      const ack = () => {
        unread -= bytes.byteLength;
        callback();
      };
      try {
        control?.enqueue(bytes);
      } catch {
        return; // The reader cancelled; its reset is under way.
      }
      if ((control?.desiredSize ?? 0) > 0) ack();
      else acks.push(ack);
    },
    on(
      event: "data" | "end" | "close" | "hangup" | "error" | "abort",
      listener: (bytes: Uint8Array) => void,
    ) {
      const none = new Uint8Array(0);
      if (event === "data") deliver = listener;
      else if (event === "end") endListeners.push(() => listener(none));
      else if (event === "close") closeListeners.push(() => listener(none));
      else if (event === "abort") abortListeners.push(() => listener(none));
      // No socket error can happen here: a failure is a reset. Nothing is held between the
      // caller's end and the mux, so there is no hangup either.
    },
    once() {
      // `connect` is the machine side's: a client stream is open at READY.
    },
  };
  const stream: TunnelStream = {
    readable,
    closed,
    write(chunk) {
      if (destroyed || aborted)
        return Promise.reject(new ClientError("tunnel_reset", "Tunnel stream closed"));
      if (endRequested) return Promise.reject(new Error("Tunnel stream already ended"));
      if (chunk.byteLength === 0) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // A copy: the caller may reuse its buffer once the promise settles, or before.
      queue.push({ chunk: chunk.slice(), resolve, reject });
      queuedBytes += chunk.byteLength;
      pump();
      return promise;
    },
    end() {
      if (endRequested || destroyed || aborted) return;
      endRequested = true;
      pump();
    },
    reset,
  };
  return { socket, stream };
}
