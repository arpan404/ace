// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import type {
  NativeSendResult,
  NativeSocketEvent,
  NativeSocketHandle,
} from "@ace/provider-kit/native-transport";
import { warnTransportUnderflow } from "@ace/provider-kit/native-transport";
import type { MainSocket } from "./main-socket.ts";

/** `ws`'s constants, as `readyState` reports them. */
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
type ReadyState = 0 | 1 | 2 | 3;

/** `ws`'s error for a text send whose payload is not UTF-8 (its receiver's words). */
const INVALID_UTF8 = "Invalid WebSocket frame: invalid UTF-8 sequence";
/** The outbound queue spent its bound: nothing was queued or counted. */
const SEND_QUEUE_FULL = "WebSocket send buffer is full";

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
  /**
   * `ws`'s ready state as the handler sees it. It moves to CLOSING the moment a close, a
   * terminate or an error starts one, and the getter also takes the Rust socket's own state
   * once that is no longer OPEN, so a peer's close frame is visible before its `close` event
   * crosses the threadsafe function, as `ws` reports it. A send in between takes ws's
   * after-close path.
   */
  #state: ReadyState = OPEN;

  constructor(handle: NativeSocketHandle) {
    super();
    this.#handle = handle;
    // Events queue in Rust until this call, so nothing the peer sent between `opened` and the
    // handler's listeners is lost.
    handle.listen((event) => this.#receive(event));
  }

  get readyState(): ReadyState {
    // The Rust socket seals its state when the peer's close frame arrives, before that `close`
    // crosses the threadsafe function. Reading it here lets a caller see the closed socket on
    // the turn `ws` reports one: notification delivery must not hand a frame to a device whose
    // socket is already gone (`notification-race.process`).
    if (this.#state === OPEN) {
      const native = this.#handle.readyState();
      if (native !== OPEN) this.#state = native === CLOSED ? CLOSED : CLOSING;
    }
    return this.#state;
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
    let result: NativeSendResult;
    try {
      result = this.#handle.send(bytes, binary, id);
    } catch (error) {
      this.#callbacks.delete(id);
      throw error;
    }
    switch (result) {
      case "queued":
        return;
      case "not-open":
        // The socket closed between the state check and the enqueue: as ws, nothing was
        // queued, so the send takes the after-close path, reporting the state the socket
        // actually reached rather than the OPEN this call saw.
        this.#mirrorNativeState();
        this.#callbacks.delete(id);
        this.#sendAfterClose(bytes.byteLength, done);
        return;
      case "full":
        // The outbound queue is at its bound: this send queued and charged nothing,
        // so only its callback learns, and `bufferedAmount` stays truthful.
        this.#callbacks.delete(id);
        this.#refuse(done, SEND_QUEUE_FULL);
        return;
      case "invalid-utf8":
        this.#callbacks.delete(id);
        this.#refuse(done, INVALID_UTF8);
        return;
    }
  }

  /** After a refused enqueue: CLOSED if the close event came, else CLOSING; never OPEN. */
  #mirrorNativeState(): void {
    this.#state = this.#handle.readyState() === CLOSED ? CLOSED : CLOSING;
  }

  /** A send that queued nothing: its callback fails on the next tick, as ws's does. */
  #refuse(done: ((error?: Error) => void) | undefined, message: string): void {
    if (done === undefined) return;
    process.nextTick(done, new Error(message));
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
    this.#closing();
  }

  terminate(): void {
    this.#handle.terminate();
    // ws reports CLOSING from the call until the close event, so a handler that reacts to
    // either sees one state and no send queues behind it.
    this.#closing();
  }

  pause(): void {
    if (this.#state === CLOSED) return;
    this.#handle.pause();
  }

  resume(): void {
    if (this.#state === CLOSED) return;
    this.#handle.resume();
  }

  /** OPEN becomes CLOSING; a socket already closing keeps its own state. */
  #closing(): void {
    if (this.#state === OPEN) this.#state = CLOSING;
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
        // ws reports a failed connection as CLOSING before its error event; the daemon's
        // handler then gives the close frame its grace instead of dropping the socket.
        this.#closing();
        this.emit("error", socketError(event.code, event.message));
        return;
      case "close":
        // Every queued send reports its `sent` before this event, so the handler's close
        // listener never races a callback of its own.
        this.#state = CLOSED;
        this.emit("close", event.code, event.reason);
        warnTransportUnderflow();
        return;
    }
  }
}
