import type { MainSocket } from "./main-socket.ts";

/**
 * The main socket as services see it: one ordered delivery boundary. Every text or binary
 * frame a service writes past the outbox first lets `release` send what the outbox holds
 * (`frame-holder.ts`), so a held delta never falls behind a later reply or stream piece.
 * Compression flags and send callbacks pass through as they are.
 */
export function orderedSocket(socket: MainSocket, release: () => void): MainSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get isPaused() {
      return socket.isPaused;
    },
    send(
      data: string | Buffer | Uint8Array,
      options?: { binary?: boolean; compress?: boolean } | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ) {
      release();
      if (typeof options === "function") socket.send(data, options);
      else if (options) socket.send(data, options, callback);
      else socket.send(data, callback);
    },
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    on(event: "message" | "close" | "error", listener: never) {
      return socket.on(event as "message", listener);
    },
    once: (event, listener) => socket.once(event, listener),
    off: (event, listener) => socket.off(event, listener),
  };
}
