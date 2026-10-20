import type { Readable, Writable } from "node:stream";

/** One CDP message stream: text in, text out. */
export interface CdpTransport {
  send(message: string): void;
  close(): void;
}
export interface TransportHandlers {
  message(text: string): void;
  closed(reason: string): void;
}

/**
 * Splits a byte stream on NUL, the framing `--remote-debugging-pipe` uses.
 * Work is proportional to each chunk; a frame is copied once when it completes.
 */
export class NulFrames {
  private parts: Buffer[] = [];
  private size = 0;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  /** Returns completed frames; throws once a frame outgrows the limit. */
  push(chunk: Buffer): string[] {
    const frames: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      this.size += piece.length;
      if (this.size > this.limit) throw new Error("CDP message size limit");
      if (piece.length) this.parts.push(piece);
      if (end === -1) return frames;
      frames.push(
        this.parts.length === 1
          ? (this.parts[0]?.toString("utf8") ?? "")
          : Buffer.concat(this.parts, this.size).toString("utf8"),
      );
      this.parts = [];
      this.size = 0;
      start = end + 1;
    }
  }
}

/** Chrome reads commands from fd 3 and writes replies and events to fd 4. */
export function pipeTransport(
  input: Writable,
  output: Readable,
  handlers: TransportHandlers,
  limit = 256 * 1024 * 1024,
): CdpTransport {
  const frames = new NulFrames(limit);
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    output.off("data", data);
    output.destroy();
    input.destroy();
    handlers.closed(reason);
  };
  const data = (chunk: Buffer) => {
    let messages: string[];
    try {
      messages = frames.push(chunk);
    } catch (error) {
      close(error instanceof Error ? error.message : "CDP pipe framing failed");
      return;
    }
    for (const message of messages) {
      if (closed) return;
      handlers.message(message);
    }
  };
  output.on("data", data);
  output.once("close", () => close("Browser pipe closed"));
  output.once("error", (error) => close(error.message));
  input.once("error", (error) => close(error.message));
  return {
    send(message) {
      if (closed) throw new Error("Browser pipe closed");
      input.write(`${message}\0`);
    },
    close: () => close("Browser pipe closed"),
  };
}
