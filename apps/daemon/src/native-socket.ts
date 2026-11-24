// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import type { NativeSocketEvent, NativeSocketHandle } from "@ace/provider-kit/native-transport";
import { warnTransportUnderflow } from "@ace/provider-kit/native-transport";
import type { MainSocket } from "./main-socket.ts";

/** `ws`'s constants, as `readyState` reports them. */
const OPEN = 1;
type ReadyState = 0 | 1 | 2 | 3;

/** `ws`'s word for a ready state, as its send-after-close error spells it. */
function stateName(state: ReadyState): string {
  switch (state) {
    case 0:
      return "CONNECTING";
    case 1:
      return "OPEN";
    case 2:
      return "CLOSING";
    case 3:
      return "CLOSED";
  }
}

/** The handle's number as `MainSocket`'s union; a state outside it can only read as closed. */
function stateOf(value: number): ReadyState {
  switch (value) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      return 3;
  }
}

/** An `error` event as `ws` reports one: an Error whose `code` names the transport's reason. */
function socketError(code: "too_big" | "protocol" | "io", message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

/** A string's UTF-8 bytes, or the bytes a Buffer or Uint8Array already holds, without copying. */
function bytesOf(data: string | Buffer | Uint8Array): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * A native transport socket seen as a `ws` socket: the daemon's one main-socket handler serves it
 * exactly as it serves a direct `ws` connection. Sends map one-to-one onto the Rust socket's
 * queue, with `ws`'s both overloads, its default of binary for bytes and text for strings, and its
 * send-after-close path; events are the binding's, in the socket's order, with Node `Buffer`s.
 * Nothing here parses or decides protocol: the Rust transport owns the wire.
 */
export class NativeSocket extends EventEmitter implements MainSocket {
  readonly #handle: NativeSocketHandle;
  /** The callback of each send the socket queued, by the id that names it back. */
  readonly #callbacks = new Map<number, (error?: Error) => void>();
  #nextId = 0;
  /** Bytes a send after close accounted for; `bufferedAmount` adds them to the socket's own. */
  #afterCloseBytes = 0;

  constructor(handle: NativeSocketHandle) {
    super();
    this.#handle = handle;
    // Events queue in Rust until this call, so nothing the peer sent between `opened` and the
    // handler's listeners is lost.
    handle.listen((event) => this.#receive(event));
  }

  get readyState(): ReadyState {
    return stateOf(this.#handle.readyState());
  }

  get bufferedAmount(): number {
    return this.#handle.bufferedAmount() + this.#afterCloseBytes;
  }

  get isPaused(): boolean {
    return this.#handle.isPaused();
  }

  send(
    data: string | Buffer | Uint8Array,
    options?: { binary?: boolean; compress?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    const done = typeof options === "function" ? options : callback;
    const flags = typeof options === "function" ? undefined : options;
    // As ws: bytes are binary and strings are text unless the caller names `binary`; `compress`
    // is accepted and ignored, because loopback negotiates no extension.
    const binary = flags?.binary ?? typeof data !== "string";
    const bytes = bytesOf(data);
    if (this.readyState !== OPEN) {
      this.#sendAfterClose(bytes.byteLength, done);
      return;
    }
    const id = this.#nextId++;
    if (done !== undefined) this.#callbacks.set(id, done);
    let queued: boolean;
    try {
      queued = this.#handle.send(bytes, binary, id);
    } catch (error) {
      this.#callbacks.delete(id);
      throw error;
    }
    // The socket closed between the state check and the enqueue: as ws, nothing was queued, so
    // the send takes the after-close path.
    if (!queued) {
      this.#callbacks.delete(id);
      this.#sendAfterClose(bytes.byteLength, done);
    }
  }

  /**
   * `ws`'s send-after-close: the bytes still count toward `bufferedAmount`, and the callback
   * learns on the next tick that nothing went out.
   */
  #sendAfterClose(length: number, done: ((error?: Error) => void) | undefined): void {
    this.#afterCloseBytes += length;
    if (done === undefined) return;
    const state = this.readyState;
    process.nextTick(
      done,
      new Error(`WebSocket is not open: readyState ${state} (${stateName(state)})`),
    );
  }

  close(code?: number, reason?: string): void {
    this.#handle.close(code ?? null, reason ?? "");
  }

  terminate(): void {
    this.#handle.terminate();
  }

  pause(): void {
    this.#handle.pause();
  }

  resume(): void {
    this.#handle.resume();
  }

  #receive(event: NativeSocketEvent): void {
    switch (event.kind) {
      case "message":
        this.emit("message", event.data, event.binary);
        return;
      case "sent": {
        const done = this.#callbacks.get(event.id);
        if (done === undefined) return;
        this.#callbacks.delete(event.id);
        done(
          event.error === null || event.error === undefined ? undefined : new Error(event.error),
        );
        return;
      }
      case "error":
        this.emit("error", socketError(event.code, event.message));
        return;
      case "close":
        // Every queued send reports its `sent` before this event, so the handler's close
        // listener never races a callback of its own.
        warnTransportUnderflow();
        this.emit("close", event.code, event.reason);
        return;
    }
  }
}
