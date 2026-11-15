import { WebSocket } from "ws";
import type { ClientOptions } from "ws";
import { systemClock } from "./clock.ts";
import { upgradeRefusal } from "./refusal.ts";
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
  /**
   * Called with each frame's size as it arrives, before it is queued: false drops it on
   * arrival, so a frame the relay won't forward is never held.
   */
  #onFrame: (bytes: number) => boolean;
  /** Waiting for the queue to be empty (`whenEmpty`). */
  #emptied: (() => void)[] = [];
  /** How the reader closes a socket it refuses a frame from; `socket.close` by default. */
  #refuse: (code: number) => void;
  #sensitive: () => boolean;
  /** Frames taken while `sensitive`: zero-filled once forwarded. */
  #marked = new WeakSet<Uint8Array>();
  constructor(
    socket: WebSocket,
    options: {
      permit?: () => Promise<void> | undefined;
      onFrame?: (bytes: number) => boolean;
      refuse?: (code: number) => void;
      /**
       * Whether a frame arriving now is first-flight material (a client not yet paired): such a
       * frame is zero-filled once forwarded (`wipeWhenSent`), as everything dropped always is.
       */
      sensitive?: () => boolean;
    } = {},
  ) {
    this.#sensitive = options.sensitive ?? (() => false);
    this.#socket = socket;
    this.#refuse = options.refuse ?? ((code) => socket.close(code));
    this.#permit = options.permit ?? (() => undefined);
    this.#onFrame = options.onFrame ?? (() => true);
    socket.on("message", (data, binary) => {
      if (!binary) {
        this.fail(new Error("Binary frames required"));
        this.#refuse(1003);
        return;
      }
      if (this.#error) return;
      if (Array.isArray(data)) {
        // A fragmented message: one buffer of its own, and the fragments wiped at once.
        const whole = Buffer.concat(data);
        for (const fragment of data) fragment.fill(0);
        this.#take(whole);
      } else this.#take(data instanceof ArrayBuffer ? Buffer.from(data) : data);
    });
    socket.on("close", () => this.fail(new Error("Relay connection closed")));
    socket.on("error", (error) => this.fail(error));
  }
  /**
   * A client's first frame that came in its upgrade request (ADR 0155, step 3): taken exactly as
   * if it had arrived as a frame, before any that did. The reader owns `frame` from here, the
   * same buffer and no copy: it is zero-filled when dropped or once forwarded.
   */
  inject(frame: Uint8Array): void {
    if (this.#error) {
      frame.fill(0);
      return;
    }
    this.#take(
      Buffer.isBuffer(frame)
        ? frame
        : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
    );
  }
  /**
   * Zero-fills `frame` once `written` settles, if it was taken while `sensitive`: a client's
   * first-flight frame, after the socket has finished sending it.
   */
  wipeWhenSent(frame: Uint8Array, written: Promise<unknown>): void {
    if (!this.#marked.has(frame)) return;
    this.#marked.delete(frame);
    void written.then(
      () => frame.fill(0),
      () => frame.fill(0),
    );
  }
  #take(frame: Buffer): void {
    {
      const socket = this.#socket;
      if (!this.#onFrame(frame.length)) {
        frame.fill(0);
        return;
      }
      if (
        frame.length > FRAME_LIMIT ||
        this.#bytes + frame.length > QUEUE_LIMIT ||
        this.#queue.length >= 256
      ) {
        frame.fill(0);
        this.fail(new Error("Frame queue limit"));
        this.#refuse(1009);
        return;
      }
      if (this.#sensitive()) this.#marked.add(frame);
      if (this.#pending) {
        const pending = this.#pending;
        this.#pending = undefined;
        pending.resolve(frame);
      } else {
        this.#queue.push(frame);
        this.#bytes += frame.length;
        if (this.#bytes >= 256 * 1024 || this.#queue.length >= 128) socket.pause();
      }
    }
  }
  get bufferedBytes(): number {
    return this.#bytes;
  }
  /** Resolves once nothing is queued: every frame taken, or the queue dropped by `fail`. */
  whenEmpty(): Promise<void> {
    if (!this.#queue.length) return Promise.resolve();
    return new Promise((resolve) => this.#emptied.push(resolve));
  }
  #empty(): void {
    if (this.#queue.length) return;
    for (const resolve of this.#emptied.splice(0)) resolve();
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
    // What is dropped is wiped: a client's queued first-flight frames above all.
    for (const frame of this.#queue) frame.fill(0);
    this.#queue = [];
    this.#bytes = 0;
    this.#pending?.reject(error);
    this.#pending = undefined;
    this.#empty();
  }
  #read(): Promise<Buffer> {
    if (this.#error) return Promise.reject(this.#error);
    const frame = this.#queue.shift();
    if (frame) {
      this.#bytes -= frame.length;
      this.#resume();
      this.#empty();
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
    let handed = false;
    try {
      await permit;
      if (this.#error) throw this.#error;
      handed = true;
      return frame;
    } finally {
      release();
      // Taken off the queue but never handed on (the wait failed, or the reader did meanwhile):
      // a first-flight frame is wiped here, as `fail` wipes what is still queued.
      if (!handed) this.#wipeMarked(frame);
    }
  }
  /** Zero-fills `frame` now if it was taken while `sensitive`. */
  #wipeMarked(frame: Uint8Array): void {
    if (!this.#marked.delete(frame)) return;
    frame.fill(0);
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
  protocols: string[] = [],
): Promise<{ socket: WebSocket; reader: FrameReader }> {
  const options: ClientOptions & { closeTimeout: number } = {
    maxPayload: FRAME_LIMIT,
    perMessageDeflate: false,
    maxFragments: 256,
    maxBufferedChunks: 256,
    // After the close handshake, stop waiting for the relay to end TCP. A Durable Object keeps a
    // closed hibernatable socket's connection open until the object sleeps (about ten seconds
    // under workerd), which would delay every refusal by that long. ws 8.21 reads this option;
    // its type definitions don't list it yet.
    closeTimeout: 1000,
  };
  const socket = new WebSocket(url, protocols, options);
  const reader = new FrameReader(socket);
  const abort = () => socket.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal?.removeEventListener("abort", abort));
  const cancel = clock.schedule(timeoutMs, abort);
  try {
    if (signal?.aborted) abort();
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", (error) => reject(upgradeRefusal(error) ?? error));
      socket.once("close", () => reject(new Error("Connection closed")));
    });
    return { socket, reader };
  } finally {
    cancel();
  }
}
