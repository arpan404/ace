import type { Socket } from "node:net";
import type { PreviewSocket } from "./relay-mux.ts";
import { windowSize } from "./relay-wire.ts";

/**
 * A Node socket as a relay stream's socket. The mux takes chunks of at most one window and
 * resets a stream that hands it more. Node reads sockets 64 KiB at a time, but Bun reads up to
 * 512 KiB whatever the high-water mark, so a larger read is split here: the mux gets one window
 * at a time, and the socket stays paused (reading nothing more) until the rest has gone.
 */
export function previewSocket(socket: Socket): PreviewSocket {
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  let rest: Buffer | undefined;
  let paused = false;
  const next = () => {
    if (paused || !deliver) return;
    if (!rest) {
      socket.resume();
      return;
    }
    const piece = rest.subarray(0, windowSize);
    rest = rest.byteLength > windowSize ? rest.subarray(windowSize) : undefined;
    deliver(piece);
    // The mux pauses while it sends a piece; if it didn't, keep going.
    next();
  };
  return {
    get readableLength() {
      return socket.readableLength + (rest?.byteLength ?? 0);
    },
    get writableLength() {
      return socket.writableLength;
    },
    pause: () => {
      paused = true;
      socket.pause();
    },
    resume: () => {
      paused = false;
      next();
    },
    destroy: () => {
      rest = undefined;
      socket.destroy();
    },
    end: () => socket.end(),
    write: (bytes, callback) => socket.write(bytes, callback),
    on(event: "data" | "end" | "close" | "error", listener: (bytes: Uint8Array) => void) {
      if (event !== "data") return socket.on(event, listener);
      deliver = listener;
      return socket.on("data", (chunk: Buffer) => {
        if (chunk.byteLength <= windowSize) return listener(chunk);
        socket.pause();
        rest = chunk;
        next();
      });
    },
    once: (event, listener) => socket.once(event, listener),
  };
}
