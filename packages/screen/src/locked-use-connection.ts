/*
 * One connection to the locked use service over its Unix socket. Requests are matched to
 * replies by id; `state`, `completion` and `error` messages go to event listeners. A bad frame
 * length closes the connection, and closing fails every request still waiting.
 */
import { createConnection, type Socket } from "node:net";
import type { Scheduler } from "./runtime.ts";
import {
  LockedUseFrameDecoder,
  decodeLockedUseMessage,
  encodeLockedUseRequest,
  type LockedUseEvent,
  type LockedUseRequest,
  type LockedUseServiceStatus,
} from "./locked-use-wire.ts";

/** The service refused a request: `code` is its wire error code. */
export class LockedUseReplyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LockedUseReplyError";
    this.code = code;
  }
}

/** The connection closed or a request went unanswered. */
export class LockedUseConnectionError extends Error {
  readonly code: "closed" | "timeout";
  constructor(code: "closed" | "timeout", message: string) {
    super(message);
    this.name = "LockedUseConnectionError";
    this.code = code;
  }
}

export interface LockedUseConnectionOptions {
  nextId: () => string;
  scheduler: Scheduler;
  /** How long a request may wait for its reply. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (status: LockedUseServiceStatus | undefined) => void;
  reject: (error: Error) => void;
  stop: () => void;
}

export class LockedUseConnection {
  readonly #socket: Socket;
  readonly #options: LockedUseConnectionOptions;
  readonly #decoder = new LockedUseFrameDecoder();
  readonly #pending = new Map<string, Pending>();
  readonly #events = new Set<(event: LockedUseEvent) => void>();
  readonly #closes = new Set<() => void>();
  #closed = false;

  constructor(socket: Socket, options: LockedUseConnectionOptions) {
    this.#socket = socket;
    this.#options = options;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends a request; resolves with the reply's status, or rejects with its error. */
  request(request: LockedUseRequest): Promise<LockedUseServiceStatus | undefined> {
    if (this.#closed)
      return Promise.reject(new LockedUseConnectionError("closed", "Locked use service closed"));
    const id = this.#options.nextId();
    return new Promise((resolve, reject) => {
      const stop = this.#options.scheduler.after(this.#options.requestTimeoutMs ?? 5_000, () => {
        if (!this.#pending.delete(id)) return;
        reject(new LockedUseConnectionError("timeout", `Locked use ${request.type} timed out`));
      });
      this.#pending.set(id, { resolve, reject, stop });
      try {
        this.#socket.write(encodeLockedUseRequest(id, request));
      } catch (error) {
        this.#pending.delete(id);
        stop();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Follows `state`, `completion` and `error` messages until the returned function runs. */
  onEvent(listener: (event: LockedUseEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** Called once when the connection closes; at once if it already has. */
  onClose(listener: () => void): () => void {
    if (this.#closed) {
      listener();
      return () => {};
    }
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    const error = new LockedUseConnectionError("closed", "Locked use service closed");
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.stop();
      pending.reject(error);
    }
    for (const listener of [...this.#closes]) listener();
    this.#closes.clear();
    this.#events.clear();
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    let frames: Buffer[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      // A bad length leaves no way to find the next frame.
      this.close();
      return;
    }
    for (const frame of frames) {
      if (this.#closed) return;
      const message = decodeLockedUseMessage(frame);
      if (!message || message.type === "unknown") continue;
      if (message.type === "reply") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        pending.stop();
        if (message.ok) pending.resolve(message.status);
        else pending.reject(new LockedUseReplyError(message.error.code, message.error.message));
        continue;
      }
      for (const listener of [...this.#events]) listener(message);
    }
  }
}

/** Connects to the service's socket at `path`. */
export function connectLockedUse(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const failed = (error: Error) => reject(error);
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve(socket);
    });
  });
}
