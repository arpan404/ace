import type { Socket } from "node:net";
import type { TunnelStream } from "./tunnel-contract.ts";

export interface PipeEvents {
  /** Bytes the browser sent after its CONNECT, before the stream opened. */
  first?: Uint8Array | undefined;
  /** The machine's side sent its first bytes: the port is served. */
  onServed?(): void;
  /** The stream was reset before the machine's side sent anything: nothing listens there. */
  onRefused?(): void;
}

const bytesOf = (chunk: Buffer) => new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

/**
 * Moves one browser connection's bytes to and from its tunnel stream, with backpressure both
 * ways: the socket stops reading until the tunnel admits each chunk, and the stream is not read
 * again until the socket has drained. A half-close travels as a half-close (`end`), either way;
 * anything abrupt (a socket error, a stream reset, a close before both sides ended) resets the
 * other side. The socket must allow half-open connections.
 */
export function pipeTunnel(socket: Socket, stream: TunnelStream, events: PipeEvents = {}): void {
  let sentEnd = false;
  let receivedEnd = false;
  let served = false;
  let finished = false;
  const reader = stream.readable.getReader();
  const abort = () => {
    if (finished) return;
    finished = true;
    stream.reset();
    reader.cancel().catch(() => {});
    if (!socket.destroyed) {
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    }
  };

  // Browser → machine.
  const write = (chunk: Uint8Array) => {
    socket.pause();
    stream.write(chunk).then(
      () => {
        if (!finished && !socket.destroyed) socket.resume();
      },
      () => abort(),
    );
  };
  socket.on("data", (chunk: Buffer) => write(bytesOf(chunk)));
  socket.on("end", () => {
    if (finished) return;
    sentEnd = true;
    stream.end();
  });
  socket.on("error", () => abort());
  socket.on("close", () => {
    if (!(sentEnd && receivedEnd)) abort();
    finished = true;
  });
  if (events.first?.length) write(events.first);

  // Machine → browser.
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          receivedEnd = true;
          if (!socket.destroyed) socket.end();
          return;
        }
        if (!served && next.value.byteLength > 0) {
          served = true;
          events.onServed?.();
        }
        if (!socket.write(next.value))
          await new Promise<void>((resume) => {
            const done = () => {
              socket.off("drain", done);
              socket.off("close", done);
              resume();
            };
            socket.on("drain", done);
            socket.on("close", done);
          });
      }
    } catch {
      if (finished) return;
      if (!served) events.onRefused?.();
      abort();
    }
  })();
}
