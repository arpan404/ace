import { EventEmitter } from "node:events";
import { RelayStreamClosed, type HostChannel } from "@ace/relay";
import type { ChannelClose, EarlySubscribe, HelloConfirm } from "@ace/protocol";
import type { NkSession } from "./relay-nk/admission.ts";
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
  /**
   * The relay host key this channel came through, when the daemon takes NK on it (ADR 0155):
   * its welcome announces NK, and tickets handed on it are bound to this key.
   */
  relayEpoch?: string | undefined;
  /**
   * An NK stream not yet confirmed (ADR 0155): `hello` was rebuilt from its `hello.early`, and
   * what a hello runs on the device waits for `confirmed`.
   */
  early?: EarlyRelayMain | undefined;
}

/** What the main-socket handler needs of an unconfirmed NK main channel. */
export interface EarlyRelayMain {
  subscribes: EarlySubscribe[];
  session: NkSession;
  confirmed: Promise<HelloConfirm | undefined>;
  /** Resolved by the main-socket handler: true once the confirmed session may be read. */
  readable: PromiseWithResolvers<boolean>;
}

/** Output an unconfirmed socket couldn't send yet, in order. */
type Held = {
  data: string | Buffer | Uint8Array;
  binary: boolean;
  compress: boolean;
  done?: (error?: Error) => void;
};

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
  /** Before confirmation: the session whose output budget applies, and what waits past it. */
  #session: NkSession | undefined;
  #held: Held[] = [];
  #heldBytes = 0;
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
    return this.#channel.bufferedBytes + this.#heldBytes;
  }
  get isPaused(): boolean {
    return this.#paused;
  }
  /**
   * Deliver `first` (the hello the relay host already read) and then every message the channel
   * receives, in order, until it closes. Reading stops while paused, as a ws socket's does.
   */
  start(
    first: string,
    early?: { now: string[]; after: string[]; readAfter: Promise<boolean>; session: NkSession },
  ): void {
    this.emit("message", Buffer.from(first), false);
    if (early) {
      this.#session = early.session;
      for (const message of early.now) this.emit("message", Buffer.from(message), false);
    }
    void (async () => {
      try {
        // An unconfirmed NK stream's next message is its confirmation, which isn't ours to read:
        // nothing the client sends is taken until it has confirmed.
        if (early && !(await early.readAfter)) {
          this.terminate();
          return;
        }
        this.#release();
        // Subscribes that waited for the confirmation come first, then the client's own.
        for (const message of early?.after ?? []) this.emit("message", Buffer.from(message), false);
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
  /** Confirmed: the output budget lifts and whatever waited goes, in order. */
  #release(): void {
    this.#session = undefined;
    const held = this.#held.splice(0);
    this.#heldBytes = 0;
    for (const { data, binary, compress, done } of held) this.#write(data, binary, compress, done);
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
    const compress = flags.compress !== false;
    // Before confirmation at most 256 KiB goes out or waits in the channel; the rest is held
    // here, in order, until the client confirms (ADR 0155).
    const session = this.#session;
    if (session) {
      const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
      if (this.#held.length || !session.output(size)) {
        this.#held.push({ data, binary, compress, ...(done ? { done } : {}) });
        this.#heldBytes += size;
        return;
      }
    }
    this.#write(data, binary, compress, done);
  }
  #write(
    data: string | Buffer | Uint8Array,
    binary: boolean,
    compress: boolean,
    done: ((error?: Error) => void) | undefined,
  ): void {
    if (this.#state !== OPEN) {
      done?.(new Error("Relay channel closed"));
      return;
    }
    const task =
      binary && typeof data !== "string"
        ? this.#channel.sendBinary(data)
        : this.#channel.sendText(
            typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
            this.#deflate && compress,
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
    const held = this.#held.splice(0);
    this.#heldBytes = 0;
    for (const { done } of held) done?.(new Error("Relay channel closed"));
    this.resume();
    // A ws socket reports its close later too; handlers never see it inside their own call.
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }
}
