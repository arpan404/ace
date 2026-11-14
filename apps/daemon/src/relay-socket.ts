import { EventEmitter } from "node:events";
import { RelayStreamClosed, type HostChannel } from "@ace/relay";
import type { ChannelClose } from "@ace/protocol";
import type { MainSocket } from "./main-socket.ts";
import type { SessionActor } from "./devices.ts";
import type { DeliveryRuntime } from "./delivery-runtime.ts";
import { DAEMON_CLOSE_GRACE_MS } from "./server-socket-close.ts";
import { BULK, INTERACTIVE } from "@ace/secure-channel";
import { LaneRouter, type Routed } from "./relay-lanes.ts";

/**
 * With lanes, bulk bytes up to this much don't count as pressure to the outbox: the channel
 * sends interactive messages ahead of them, so the outbox keeps handing those over while a
 * snapshot (up to 1 MiB as one message) drains. Bounded: past it, bulk counts in full.
 */
const BULK_ALLOWANCE = 1280 * 1024;
const unrouted: Routed = { lane: INTERACTIVE, sent: () => {} };

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
  /** Set while the client announced lanes (`hello.flowControl` has `lanes`). */
  #router: LaneRouter | undefined;
  constructor(
    channel: HostChannel,
    options: { deflate: boolean; delay: DeliveryRuntime["delay"] },
  ) {
    super();
    this.#channel = channel;
    this.#deflate = options.deflate;
    this.#delay = options.delay;
    // The relay host turns lanes on before it hands the channel over, as it reads the hello.
    if (channel.interleaving) this.#router = new LaneRouter();
    void channel.closed.then((cause) => this.#finish(...endedBy(cause)));
  }
  get readyState(): 0 | 1 | 2 | 3 {
    return this.#state;
  }
  get bufferedAmount(): number {
    const total = this.#channel.bufferedBytes;
    if (!this.#channel.interleaving || !this.#channel.queuedIn) return total;
    const bulk = this.#channel.queuedIn(BULK);
    return total - bulk + Math.max(0, bulk - BULK_ALLOWANCE);
  }
  /** The lane for the next message: interactive unless it must wait behind bulk. */
  #route(text: string): Routed {
    return this.#router?.route(text) ?? unrouted;
  }
  #routeOpaque(): Routed {
    return this.#router?.routeOpaque() ?? unrouted;
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
          if (typeof frame === "string") {
            this.#router?.observe(frame);
            this.emit("message", Buffer.from(frame), false);
          } else
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
    let routed: Routed;
    let task: Promise<void>;
    if (binary) {
      routed = this.#routeOpaque();
      task = this.#channel.sendBinary(data, routed.lane);
    } else {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      routed = this.#route(text);
      task = this.#channel.sendText(text, this.#deflate && flags.compress !== false, routed.lane);
    }
    task.then(
      () => {
        routed.sent();
        done?.();
      },
      (error: unknown) => {
        routed.sent();
        done?.(error instanceof Error ? error : new Error("Relay send failed"));
      },
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
    const routed = this.#route(JSON.stringify(goodbye));
    void this.#channel
      .sendText(JSON.stringify(goodbye), false, routed.lane)
      .finally(() => routed.sent())
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
