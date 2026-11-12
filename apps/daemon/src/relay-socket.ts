import { EventEmitter } from "node:events";
import { RelayStreamClosed, type HostChannel } from "@ace/relay";
import type { ChannelClose } from "@ace/protocol";
import type { MainSocket } from "./main-socket.ts";
import type { SessionActor } from "./devices.ts";
import type { DeliveryRuntime } from "./delivery-runtime.ts";
import { DAEMON_CLOSE_GRACE_MS } from "./server-socket-close.ts";

/** A main channel the relay host authenticated, handed to the daemon's main-socket handler. */
export interface RelayedMain {
  channel: HostChannel;
  /** The hello as received, replayed to the handler as the channel's first message. */
  hello: string;
  actor: SessionActor;
  /** For an account device: whether it still holds access (account, machine code). */
  stillAdmitted?: (() => boolean) | undefined;
  /** For an account device: the ace account its grant names. */
  account?: string | undefined;
  /** For an account device: when its grant runs out, unless the channel refreshes it. */
  grantExpiresAt?: number | undefined;
  /** The hello asked for deflated bulk JSON (`compression: ["deflate-raw"]`). */
  deflate: boolean;
}

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * The close a channel's end reads as. The relay's own close of the stream keeps its code and
 * reason ("Peer closed" when the far end went away); any other failure is an abnormal 1006 with
 * what broke (a decrypt failure, an overrun window). A local close has already finished.
 */
function endedBy(cause: Error | undefined): [number, string] {
  if (cause instanceof RelayStreamClosed) return [cause.code, cause.reason];
  return [1006, cause?.message.slice(0, 123) ?? ""];
}

/**
 * A relayed main channel seen as a socket, so the daemon's one main-socket handler serves it
 * exactly as it serves a direct one: same hello, scopes, admission, outbox backpressure,
 * replay and close codes. The relay has no close frame, so a close sends `channel.close` with
 * its code and reason as the channel's last message. Messages pass as text the handler parses
 * itself; nothing is schema-checked twice.
 */
export class RelaySocket extends EventEmitter implements MainSocket {
  readonly #channel: HostChannel;
  /** The peer said it inflates (`hello.compression`): bulk JSON may go deflated. */
  readonly #deflate: boolean;
  #state: 0 | 1 | 2 | 3 = OPEN;
  #paused = false;
  #resumed: (() => void) | undefined;
  readonly #delay: DeliveryRuntime["delay"];
  constructor(
    channel: HostChannel,
    options: { deflate: boolean; delay: DeliveryRuntime["delay"] },
  ) {
    super();
    this.#channel = channel;
    this.#deflate = options.deflate;
    this.#delay = options.delay;
    void channel.closed.then((cause) => this.#finish(...endedBy(cause)));
  }
  get readyState(): 0 | 1 | 2 | 3 {
    return this.#state;
  }
  get bufferedAmount(): number {
    return this.#channel.bufferedBytes;
  }
  get isPaused(): boolean {
    return this.#paused;
  }
  /**
   * Deliver `first` (the hello the relay host already read) and then every message the channel
   * receives, in order, until it closes. Reading stops while paused, as a ws socket's does.
   */
  start(first: string): void {
    this.emit("message", Buffer.from(first), false);
    void (async () => {
      try {
        while (this.#state === OPEN) {
          if (this.#paused) await new Promise<void>((resolve) => (this.#resumed = resolve));
          if (this.#state !== OPEN) return;
          const frame = await this.#channel.receiveRaw();
          if (this.#state !== OPEN) return;
          if (typeof frame === "string") this.emit("message", Buffer.from(frame), false);
          else
            this.emit("message", Buffer.from(frame.buffer, frame.byteOffset, frame.length), true);
        }
      } catch {
        this.terminate();
      }
    })();
  }
  send(
    data: string | Buffer | Uint8Array,
    options?: { binary?: boolean; compress?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    const done = typeof options === "function" ? options : callback;
    const flags = typeof options === "function" ? {} : (options ?? {});
    if (this.#state !== OPEN) {
      done?.(new Error("Relay channel closed"));
      return;
    }
    // As ws does: bytes are binary unless the caller says they are text.
    const binary = typeof data !== "string" && flags.binary !== false;
    const task = binary
      ? this.#channel.sendBinary(data)
      : this.#channel.sendText(
          typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
          this.#deflate && flags.compress !== false,
        );
    task.then(
      () => done?.(),
      (error: unknown) => done?.(error instanceof Error ? error : new Error("Relay send failed")),
    );
  }
  close(code = 1000, reason = ""): void {
    if (this.#state !== OPEN) return;
    this.#state = CLOSING;
    const goodbye: ChannelClose = {
      type: "channel.close",
      code: code >= 1000 && code <= 4999 ? code : 1000,
      reason: reason.slice(0, 123),
    };
    // The goodbye is queued behind earlier messages, so it arrives last; then the channel ends.
    // A reader that stopped consuming never lets it out (flow control holds the queue), so the
    // channel ends anyway after the daemon's close grace, as a direct socket's would.
    const cancel = this.#delay(() => this.#channel.close(), DAEMON_CLOSE_GRACE_MS);
    void this.#channel
      .sendText(JSON.stringify(goodbye))
      .catch(() => {})
      .finally(() => {
        cancel();
        this.#channel.close();
      });
    this.#finish(code, reason);
  }
  terminate(): void {
    this.#channel.close();
    this.#finish(1006, "");
  }
  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#paused = false;
    const resumed = this.#resumed;
    this.#resumed = undefined;
    resumed?.();
  }
  #finish(code: number, reason: string): void {
    if (this.#state === CLOSED) return;
    this.#state = CLOSED;
    this.resume();
    // A ws socket reports its close later too; handlers never see it inside their own call.
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }
}
