import { WebSocket } from "ws";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
export const FRAME_LIMIT = 65535;
export const QUEUE_LIMIT = 1024 * 1024;
export class FrameReader {
  #socket: WebSocket;
  #queue: Buffer[] = [];
  #bytes = 0;
  #error: Error | undefined;
  #holds = 0;
  #pending: { resolve(value: Buffer): void; reject(error: Error): void } | undefined;
  #permit: () => Promise<void> | undefined;
  #onFrame: () => void;
  constructor(
    socket: WebSocket,
    options: { permit?: () => Promise<void> | undefined; onFrame?: () => void } = {},
  ) {
    this.#socket = socket;
    this.#permit = options.permit ?? (() => undefined);
    this.#onFrame = options.onFrame ?? (() => {});
    socket.on("message", (data, binary) => {
      if (!binary) {
        this.fail(new Error("Binary frames required"));
        socket.close(1003);
        return;
      }
      if (this.#error) return;
      const frame = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      this.#onFrame();
      if (
        frame.length > FRAME_LIMIT ||
        this.#bytes + frame.length > QUEUE_LIMIT ||
        this.#queue.length >= 256
      ) {
        this.fail(new Error("Frame queue limit"));
        socket.close(1009);
        return;
      }
      if (this.#pending) {
        const pending = this.#pending;
        this.#pending = undefined;
        pending.resolve(frame);
      } else {
        this.#queue.push(frame);
        this.#bytes += frame.length;
        if (this.#bytes >= 256 * 1024 || this.#queue.length >= 128) socket.pause();
      }
    });
    socket.on("close", () => this.fail(new Error("Relay connection closed")));
    socket.on("error", (error) => this.fail(error));
  }
  get bufferedBytes(): number {
    return this.#bytes;
  }
  hold(): () => void {
    this.#holds++;
    this.#socket.pause();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds--;
      this.#resume();
    };
  }
  #resume(): void {
    if (this.#holds === 0 && this.#bytes < 128 * 1024 && this.#queue.length < 64 && !this.#error)
      this.#socket.resume();
  }
  fail(error: Error): void {
    this.#error = error;
    this.#queue = [];
    this.#bytes = 0;
    this.#pending?.reject(error);
    this.#pending = undefined;
  }
  #read(): Promise<Buffer> {
    if (this.#error) return Promise.reject(this.#error);
    const frame = this.#queue.shift();
    if (frame) {
      this.#bytes -= frame.length;
      this.#resume();
      return Promise.resolve(frame);
    }
    if (this.#pending) return Promise.reject(new Error("Concurrent receive is unsupported"));
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }
  async next(): Promise<Buffer> {
    const frame = await this.#read();
    const permit = this.#permit();
    if (!permit) return frame;
    const release = this.hold();
    try {
      await permit;
      if (this.#error) throw this.#error;
      return frame;
    } finally {
      release();
    }
  }
}
export function sendFrame(socket: WebSocket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Socket closed"));
      return;
    }
    socket.send(frame, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}
export function relayAddress(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(base);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Expected ws or wss relay URL");
  url.pathname = path;
  url.search = new URLSearchParams(query).toString();
  url.hash = "";
  return url.toString();
}
export async function dial(
  url: string,
  signal?: AbortSignal,
  clock: Clock = systemClock(),
  timeoutMs = 10000,
): Promise<{ socket: WebSocket; reader: FrameReader }> {
  const socket = new WebSocket(url, {
    maxPayload: FRAME_LIMIT,
    perMessageDeflate: false,
    maxFragments: 256,
    maxBufferedChunks: 256,
  });
  const reader = new FrameReader(socket);
  const abort = () => socket.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", abort));
  const cancel = clock.schedule(timeoutMs, abort);
  try {
    if (signal?.aborted) abort();
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Connection closed")));
    });
    return { socket, reader };
  } finally {
    cancel();
  }
}
