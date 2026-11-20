import type { Socket } from "node:net";
import type { PreviewSocket } from "./relay-mux.ts";
import { windowSize } from "./relay-wire.ts";

/**
 * A Node socket as a relay stream's socket. The mux takes chunks of at most one window and
 * resets a stream that hands it more. Node reads sockets 64 KiB at a time, but Bun reads up to
 * 512 KiB whatever the high-water mark, so a larger read is split here: the mux gets one window
 * at a time, and the socket stays paused (reading nothing more) until the rest has gone.
 *
 * Bytes held here always go first: a chunk that arrives while some are held queues behind them,
 * and the socket's end waits until every held byte has been delivered.
 *
 * A paused socket holds at most one read. On Bun, `resume()` starts a native read straight away,
 * and a `pause()` right after it does not stop that read landing. If the socket were paused with
 * chunks still buffered, each resume would emit one chunk and gain a read, so a paused socket
 * would come to hold two reads. So pausing a socket that was flowing first reads out what it has
 * buffered (`read()` emits it as data, which queues it in `held`), and the one read the resume
 * started lands in an empty buffer. The buffer is read here, synchronously, rather than left to
 * the stream's flow loop, so the bound does not depend on how a runtime schedules that loop.
 * On Node the same applies; its reads are 64 KiB, so it only moves buffered chunks into `held`.
 *
 * Only a real end reaches the mux, because the mux treats a close after an end as graceful and
 * sends END. Bun emits `end` on a socket destroyed locally too; that end is an abort, so it is
 * dropped and the close goes through at once. The filter holds because `destroy()` marks the
 * socket destroyed synchronously and every event it causes comes later. If it ever missed, the
 * failure would not be safe: the mux would send END for an aborted socket, so the destroy tests
 * in relay-close.process.test.ts assert that no END is sent. Probes on Bun 1.4.4 and Node 26
 * confirmed the order: on a local destroy Bun emits `end` with `destroyed` already true and Node
 * emits no `end`; a real end arrives on both with `destroyed` still false.
 *
 * The adapter only reports what its socket did; the mux decides what that means for the stream
 * and owns its one deadline. When the raw socket closes after its end while bytes read before
 * that end are still held, it reports a `hangup` at once (the socket is closed, so the mux's
 * deadline starts there) and the `end` once the held bytes have been handed over; otherwise it
 * reports the raw close as it comes, after the end or (an abort) without one.
 */
export function previewSocket(socket: Socket): PreviewSocket {
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  const held: Buffer[] = [];
  let heldBytes = 0;
  let paused = false;
  let ended = false;
  let endDelivered = false;
  /** The mux removed the stream: nothing more is handed over. */
  let removed = false;
  const endListeners: (() => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const hangupListeners: (() => void)[] = [];
  const emitEnd = () => {
    endDelivered = true;
    for (const listener of endListeners) listener();
  };
  const next = () => {
    if (paused || !deliver || removed) return;
    const head = held[0];
    if (!head) {
      if (ended && !endDelivered) emitEnd();
      else if (!ended) socket.resume();
      return;
    }
    const piece = head.subarray(0, windowSize);
    if (head.byteLength > windowSize) held[0] = head.subarray(windowSize);
    else held.shift();
    heldBytes -= piece.byteLength;
    deliver(piece);
    // The mux pauses while it sends a piece; if it didn't, keep going.
    next();
  };
  socket.on("end", () => {
    if (socket.destroyed) return;
    ended = true;
    if (held.length === 0) emitEnd();
  });
  socket.on("close", () => {
    const listeners = ended && !endDelivered ? hangupListeners : closeListeners;
    for (const listener of listeners) listener();
  });
  return {
    get readableLength() {
      return socket.readableLength + heldBytes;
    },
    get writableLength() {
      return socket.writableLength;
    },
    pause: () => {
      paused = true;
      // Only a socket that was flowing can hold chunks it has not emitted yet. One already
      // paused holds at most the read that landed after it paused, and reading that out would
      // only let another land behind it.
      const flowing = socket.readableFlowing === true;
      socket.pause();
      // One `read()` with no size returns everything a paused stream buffers. It is not repeated:
      // on Bun a read can start another native read, so reading until the buffer stays empty
      // would drain the connection. A size is not passed either: asking for more than the
      // high-water mark raises it, and a paused socket would then take in more than one read.
      if (flowing && deliver && socket.readableLength > 0) socket.read();
    },
    resume: () => {
      paused = false;
      next();
    },
    destroy: () => {
      // However the stream left, a Node socket is let go the same way.
      removed = true;
      held.length = 0;
      heldBytes = 0;
      socket.destroy();
    },
    end: () => socket.end(),
    write: (bytes, callback) => socket.write(bytes, callback),
    on(
      event: "data" | "end" | "close" | "hangup" | "error" | "abort",
      listener: (bytes: Uint8Array) => void,
    ) {
      // A Node socket's local abort is its `error` or a close before its end.
      if (event === "abort") return undefined;
      if (event === "end") return endListeners.push(() => listener(Buffer.alloc(0)));
      if (event === "close") return closeListeners.push(() => listener(Buffer.alloc(0)));
      if (event === "hangup") return hangupListeners.push(() => listener(Buffer.alloc(0)));
      if (event !== "data") return socket.on(event, listener);
      deliver = listener;
      return socket.on("data", (chunk: Buffer) => {
        if (!paused && held.length === 0 && chunk.byteLength <= windowSize) return listener(chunk);
        held.push(chunk);
        heldBytes += chunk.byteLength;
        next();
      });
    },
    once: (event, listener) => socket.once(event, listener),
  };
}
