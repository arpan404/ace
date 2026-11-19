import type { FromMedia, ToMedia } from "@ace/media/wire";
import type { MediaClock } from "@ace/media/supervisor";
import type { KeyPair } from "@ace/secure-channel";
import { handOverMediaStream, type MediaAdmission, type StreamPipe } from "./handover.ts";

/*
 * Relay media streams on the daemon's side (docs/media/plan.md, "Media connection
 * authorization"): the relay offers a `purpose=media` ticket, ace-media dials it (`relay.dial`),
 * the daemon runs the handshake and the hello through ace-media (`relay.out`, `relay.pull` →
 * `relay.in`), and hands the stream's keys over (`relay.keys`). From then on ace-media alone
 * seals and opens the stream. Every step has a deadline; a stream that misses one, or whose
 * hello is refused, is closed on the priority lane (`relay.close`), which wipes it in ace-media.
 */

type Message<T extends ToMedia["type"]> = Extract<ToMedia, { type: T }>;
export type MediaGrant = Pick<Message<"relay.keys">, "connection" | "owner" | "issued">;
type Hello = Parameters<Parameters<typeof handOverMediaStream>[1]["admit"]>[0];
/** Admits a hello; `signal` aborts when the stream was given up, and nothing is granted then. */
export type AdmitMediaHello = (
  hello: Hello,
  signal: AbortSignal,
) => Promise<MediaAdmission<MediaGrant>>;

/** What the streams need from ace-media's supervisor. */
export type MediaRelayLink = {
  /** `MediaSupervisor.send`: false when ace-media can't take it now (the caller gives up). */
  send(message: ToMedia, payload?: Uint8Array): boolean;
  /** `MediaSupervisor.revoke` with a `relay.close`. */
  closeStream(message: Message<"relay.close">): void;
  /** `MediaSupervisor.need`: ace-media runs while a stream does. */
  need(): () => void;
  /** False while ace-media is marked unavailable: no stream is taken then. */
  available(): boolean;
};

/** How long a stream may take from the offer to its keys (the relay's own hello deadline). */
export const HANDOVER_DEADLINE_MS = 10_000;
/** How long a refused stream stays open for its refusal to reach the client. */
export const REFUSAL_LINGER_MS = 200;
/** How often a dial is tried again while ace-media is still starting. */
export const DIAL_RETRY_MS = 50;
/** Streams being dialed or handed over at once; past it the relay hears "busy". */
export const MAX_PENDING_STREAMS = 32;

/** The hello was refused, and the client was told why. */
class Refused extends Error {}

type Pending = {
  dialed: PromiseWithResolvers<void>;
  /** The `relay.in` frames that answered pulls, in order; one pull is outstanding at most. */
  pull?: PromiseWithResolvers<Uint8Array> | undefined;
  /** `relay.keys` is on its way: the stream is ace-media's from here on. */
  handed: boolean;
};

export class MediaRelayStreams {
  readonly #link: MediaRelayLink;
  readonly #clock: MediaClock;
  readonly #hostKeys: KeyPair;
  readonly #ephemeral: () => KeyPair;
  readonly #ids: () => string;
  readonly #pending = new Map<string, Pending>();
  /** Connections relayed streams opened, holding ace-media up until `connection.closed`. */
  readonly #held = new Map<string, () => void>();
  readonly #log: (line: string) => void;

  constructor(options: {
    link: MediaRelayLink;
    clock: MediaClock;
    hostKeys: KeyPair;
    ephemeralKey: () => KeyPair;
    /** Stream and close ids, unique for the daemon's lifetime (ace-media remembers closed ones). */
    newId: () => string;
    /** Ids and states only, never payloads: `relay.keys {stream}`. */
    log: (line: string) => void;
  }) {
    this.#link = options.link;
    this.#clock = options.clock;
    this.#hostKeys = options.hostKeys;
    this.#ephemeral = options.ephemeralKey;
    this.#ids = options.newId;
    this.#log = options.log;
  }

  /** Streams between their offer and their keys. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * A relay offered a media ticket. False turns it down (too many pending, or ace-media can't
   * dial now); otherwise the stream runs to its keys or is closed. A stream that fails before
   * ace-media joined it (a refused certificate, an unreachable relay) calls `reject`, so the
   * relay turns the client away at once and it stays on legacy delivery.
   */
  offer(joinUrl: string, admit: AdmitMediaHello, reject: () => void = () => {}): boolean {
    if (this.#pending.size >= MAX_PENDING_STREAMS || !this.#link.available()) return false;
    const stream = `rs_${this.#ids()}`;
    // ace-media starts on its first need; the dial goes out once its lanes are up.
    const release = this.#link.need();
    const pending: Pending = { dialed: Promise.withResolvers<void>(), handed: false };
    this.#pending.set(stream, pending);
    void this.#run(stream, pending, admit, joinUrl, reject).then(
      (connection) => {
        if (connection === undefined) return release();
        this.#held.get(connection)?.();
        this.#held.set(connection, release);
      },
      () => release(),
    );
    return true;
  }

  /** Routes ace-media's relay messages. True when the message was a stream's. */
  onMessage(message: FromMedia, payload: Uint8Array): boolean {
    if (message.type === "connection.closed") {
      this.#held.get(message.connection)?.();
      this.#held.delete(message.connection);
      return false;
    }
    if (
      message.type !== "relay.dialed" &&
      message.type !== "relay.failed" &&
      message.type !== "relay.in"
    )
      return false;
    const pending = this.#pending.get(message.stream);
    if (!pending) return true;
    if (message.type === "relay.dialed") pending.dialed.resolve();
    else if (message.type === "relay.failed") {
      const error = new Error(`relay ${message.reason}`);
      pending.dialed.reject(error);
      pending.pull?.reject(error);
    } else {
      const pull = pending.pull;
      pending.pull = undefined;
      pull?.resolve(payload.slice());
    }
    return true;
  }

  /** ace-media exited: every stream it was dialing or handing over is gone with it. */
  onExit(): void {
    const gone = new Error("ace-media exited");
    for (const pending of this.#pending.values()) {
      pending.dialed.reject(gone);
      pending.pull?.reject(gone);
    }
    for (const release of this.#held.values()) release();
    this.#held.clear();
  }

  /** Sends the dial, trying again while ace-media is still starting. */
  async #dial(stream: string, url: string, within: <T>(work: Promise<T>) => Promise<T>) {
    while (!this.#link.send({ type: "relay.dial", stream, url })) {
      if (!this.#link.available()) throw new Error("ace-media unavailable");
      const wait = Promise.withResolvers<void>();
      this.#clock.setTimeout(wait.resolve, DIAL_RETRY_MS);
      await within(wait.promise);
    }
  }

  async #run(
    stream: string,
    pending: Pending,
    admit: AdmitMediaHello,
    url: string,
    reject: () => void,
  ): Promise<string | undefined> {
    let joined = false;
    const deadline = Promise.withResolvers<never>();
    // The deadline cancels the hand-over itself, not only the wait for it: its keys are destroyed
    // and admission is told, so nothing it finishes later is granted or exported.
    const given = new AbortController();
    const cancel = this.#clock.setTimeout(() => {
      given.abort();
      deadline.reject(new Error("handover deadline"));
    }, HANDOVER_DEADLINE_MS);
    const within = <T>(work: Promise<T>) => Promise.race([work, deadline.promise]);
    deadline.promise.catch(() => {});
    try {
      await this.#dial(stream, url, within);
      await within(pending.dialed.promise);
      joined = true;
      const pipe: StreamPipe = {
        send: async (frame) => {
          if (!this.#link.send({ type: "relay.out", stream }, frame))
            throw new Error("ace-media unavailable");
        },
        next: () => {
          if (pending.pull) throw new Error("one pull at a time");
          const pull = Promise.withResolvers<Uint8Array>();
          pending.pull = pull;
          if (!this.#link.send({ type: "relay.pull", stream })) {
            pending.pull = undefined;
            throw new Error("ace-media unavailable");
          }
          return within(pull.promise);
        },
      };
      const handover = handOverMediaStream(pipe, {
        hostKeys: this.#hostKeys,
        ephemeralKey: this.#ephemeral(),
        signal: given.signal,
        admit,
      });
      // A result that arrives after the stream was given up is wiped, never read.
      void handover
        .then((late) => {
          if (given.signal.aborted && late.ok) late.block.fill(0);
        })
        // Its failure is the caller's below, which turns it into a closed stream.
        .catch(() => {});
      const result = await within(handover);
      if (!result.ok)
        throw result.reason === "refused" || result.reason === "not a hello"
          ? new Refused(result.reason)
          : new Error(result.reason);
      pending.handed = true;
      // The supervisor owns the block from here: it zeroes it after the write, or if dropped.
      if (!this.#link.send({ type: "relay.keys", stream, ...result.grant }, result.block))
        throw new Error("ace-media unavailable");
      this.#log(`relay.keys {${stream}}`);
      return result.grant.connection;
    } catch (error) {
      this.#log(
        `relay stream ${stream} closed: ${error instanceof Error ? error.message : "failed"}`,
      );
      if (!joined) reject();
      const close = () =>
        this.#link.closeStream({
          type: "relay.close",
          id: `rc_${this.#ids()}`,
          stream,
          reason: "handover",
        });
      // A refusal went out on the normal lane, which the priority lane's close would overtake;
      // it gets a moment to be written first. The stream holds no keys meanwhile.
      if (error instanceof Refused) this.#clock.setTimeout(close, REFUSAL_LINGER_MS);
      else close();
      return undefined;
    } finally {
      cancel();
      given.abort();
      this.#pending.delete(stream);
    }
  }
}
