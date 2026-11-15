import {
  MediaConnectResult,
  MediaStreamServerMessage,
  mediaCloseCodes,
  mediaHelloBytes,
  mediaHelloMagic,
  mediaHelloVersion,
  type MediaBinding,
  type MediaConnectionId,
  type MediaStreamClientMessage,
} from "@ace/protocol";
import type { StreamMessage } from "@ace/browser/stream";
import { decodeBase64 } from "./base64.ts";
import { StreamMessages } from "./stream-messages.ts";

/*
 * A client's media connection (ADR 0147 §4, docs/media/plan.md "Clients"): one per daemon
 * connection. It asks the main session for `media.connect`, opens the socket it names with the
 * ticket as its binary hello, and once ace-media welcomes it, names it in subscribes
 * (`binding()`), carries pictures (`onStream`) and takes the viewers' acks (`ack`). When the
 * daemon has no media connection to give (`media.delivery: legacy`, ace-media unhealthy, an
 * older daemon), the binding stays absent and everything keeps travelling on the main socket.
 * Whenever the binding changes, views resubscribe (`watch`).
 */

export interface MediaSocketEvents {
  open(): void;
  message(data: string | Uint8Array): void;
  close(code: number): void;
}

export interface MediaSocket {
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number): void;
}

export type OpenMediaSocket = (url: string, events: MediaSocketEvents) => MediaSocket;

export type MediaState =
  | { state: "off" }
  | { state: "connecting" }
  | { state: "open"; connection: MediaConnectionId }
  /** The daemon delivers on the main socket; `reason` is its code, or why the client chose to. */
  | { state: "legacy"; reason: string };

export interface MediaConnectionOptions {
  /** `media.connect` on the main session; the reply is parsed here, so any value may come back. */
  connect(): Promise<unknown>;
  socket: OpenMediaSocket;
  /** Runs `run` after `ms`; the result cancels it. */
  schedule(run: () => void, ms: number): () => void;
  /** A monotonic clock in ms, for the round trip the pings report. */
  now(): number;
}

/** Waits before trying again, by attempt; the last repeats. */
export const mediaRetryMs = [250, 1_000, 2_000, 5_000, 10_000] as const;
/** How long a legacy answer stands before the client asks again (a setting may change). */
export const mediaLegacyRetryMs = 30_000;
/** How long a first subscribe waits for the connection to settle before going legacy. */
export const mediaSettleMs = 2_000;
/** A socket that opened but hasn't been welcomed by then is dropped and tried again. */
export const mediaWelcomeMs = 5_000;
export const mediaPingMs = 5_000;

/** The 37-byte hello: `"ACEC"`, the version, the ticket's 32 bytes. */
export function mediaHello(ticket: string): Uint8Array<ArrayBuffer> {
  const base64 = ticket.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const bytes = decodeBase64(base64, 32);
  const hello = new Uint8Array(mediaHelloBytes);
  new DataView(hello.buffer).setUint32(0, mediaHelloMagic);
  hello[4] = mediaHelloVersion;
  hello.set(bytes, 5);
  return hello;
}

export class MediaConnection {
  #options: MediaConnectionOptions;
  #state: MediaState = { state: "off" };
  #epoch = 0;
  #attempt = 0;
  #socket: MediaSocket | undefined;
  #timers = new Set<() => void>();
  #settled: { promise: Promise<void>; resolve(): void } | undefined;
  #watchers = new Set<() => void>();
  #streams = new Set<(message: StreamMessage) => void>();
  #pieces = new StreamMessages((message) => {
    for (const listener of this.#streams) listener(message);
  });
  #rttMs: number | undefined;
  #pingAt: number | undefined;
  constructor(options: MediaConnectionOptions) {
    this.#options = options;
  }
  get state(): MediaState {
    return this.#state;
  }
  /** What a subscribe names now; absent: deliver on the main socket. */
  binding(): MediaBinding | undefined {
    return this.#state.state === "open" ? { connection: this.#state.connection } : undefined;
  }
  /**
   * Resolves once the connection has opened or fallen back to legacy, or after
   * `mediaSettleMs`, so a view's first subscribe names the connection when there will be one.
   */
  settled(): Promise<void> {
    if (this.#state.state !== "connecting") return Promise.resolve();
    if (!this.#settled) {
      let resolve = () => {};
      const promise = new Promise<void>((done) => (resolve = done));
      this.#settled = { promise, resolve };
      this.#after(mediaSettleMs, () => this.#settle());
    }
    return this.#settled.promise;
  }
  /** Calls `listener` whenever `binding()` changes: views resubscribe with the new one. */
  watch(listener: () => void): () => void {
    this.#watchers.add(listener);
    return () => void this.#watchers.delete(listener);
  }
  /** Stream messages arriving on the media connection. */
  onStream(listener: (message: StreamMessage) => void): () => void {
    this.#streams.add(listener);
    return () => void this.#streams.delete(listener);
  }
  /** Sends an ack (or ping) on the connection; false when it isn't open, so it goes by the main socket. */
  ack(message: MediaStreamClientMessage): boolean {
    if (this.#state.state !== "open" || !this.#socket) return false;
    try {
      this.#socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  /** The main session is ready (again): open a connection for it. */
  start(): void {
    this.#reset();
    this.#attempt = 0;
    void this.#open();
  }
  /** The main session ended: its media connection ends with it. */
  stop(): void {
    this.#reset();
    this.#set({ state: "off" });
  }
  #reset(): void {
    this.#epoch++;
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#pieces.reset();
    this.#rttMs = undefined;
    this.#pingAt = undefined;
    try {
      socket?.close(1000);
    } catch {
      /* Already closing. */
    }
  }
  async #open(): Promise<void> {
    const epoch = this.#epoch;
    this.#set({ state: "connecting" });
    let reply: unknown;
    try {
      reply = await this.#options.connect();
    } catch {
      if (epoch === this.#epoch) this.#retry("unreachable");
      return;
    }
    if (epoch !== this.#epoch) return;
    const parsed = MediaConnectResult.safeParse(reply);
    // An older daemon answers with an error it doesn't name this way: it has no media connection.
    if (!parsed.success) return this.#legacy("unsupported");
    const result = parsed.data.result;
    if (!result.ok) return this.#legacy(result.code);
    // Only the relay reaches this client: relay media streams aren't wired for it yet.
    if (!result.url) return this.#legacy("relay");
    const granted = result.connection;
    let hello: Uint8Array<ArrayBuffer>;
    try {
      hello = mediaHello(result.ticket);
    } catch {
      return this.#legacy("unsupported");
    }
    const current = () => epoch === this.#epoch;
    let welcomed = false;
    try {
      this.#socket = this.#options.socket(result.url, {
        open: () => {
          if (!current()) return;
          this.#socket?.send(hello);
          this.#after(mediaWelcomeMs, () => {
            if (current() && !welcomed) this.#drop("welcome");
          });
        },
        message: (data) => {
          if (!current()) return;
          if (typeof data !== "string") {
            if (!welcomed) return this.#drop("protocol");
            try {
              this.#pieces.receive(data);
            } catch {
              this.#drop("protocol");
            }
            return;
          }
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }
          // Unknown server messages are skipped, never fatal.
          const message = MediaStreamServerMessage.safeParse(json);
          if (!message.success) return;
          if (message.data.type === "pong") {
            if (this.#pingAt !== undefined)
              this.#rttMs = Math.max(0, Math.round(this.#options.now() - this.#pingAt));
            this.#pingAt = undefined;
            return;
          }
          if (welcomed || message.data.connection !== granted) return this.#drop("protocol");
          welcomed = true;
          this.#attempt = 0;
          this.#set({ state: "open", connection: granted });
          this.#ping(epoch);
        },
        close: (code) => {
          if (!current()) return;
          this.#socket = undefined;
          this.#pieces.reset();
          if (code === mediaCloseCodes.revoked) this.#legacy("revoked");
          else this.#retry("closed");
        },
      });
    } catch {
      this.#retry("unreachable");
    }
  }
  #ping(epoch: number): void {
    this.#after(mediaPingMs, () => {
      if (epoch !== this.#epoch || this.#state.state !== "open") return;
      this.#pingAt = this.#options.now();
      this.ack(this.#rttMs === undefined ? { type: "ping" } : { type: "ping", rttMs: this.#rttMs });
      this.#ping(epoch);
    });
  }
  /** Closes this socket and tries again. */
  #drop(reason: string): void {
    const socket = this.#socket;
    this.#reset();
    try {
      socket?.close(mediaCloseCodes.protocol);
    } catch {
      /* Already closing. */
    }
    this.#retry(reason);
  }
  #retry(reason: string): void {
    const wait = mediaRetryMs[Math.min(this.#attempt++, mediaRetryMs.length - 1)] ?? 10_000;
    this.#legacy(reason, wait);
  }
  /** Delivery stays on the main socket until the next try. */
  #legacy(reason: string, retryMs: number = mediaLegacyRetryMs): void {
    const epoch = ++this.#epoch;
    this.#set({ state: "legacy", reason });
    this.#after(retryMs, () => {
      if (epoch === this.#epoch) void this.#open();
    });
  }
  #after(ms: number, run: () => void): void {
    const cancel = this.#options.schedule(() => {
      this.#timers.delete(cancel);
      run();
    }, ms);
    this.#timers.add(cancel);
  }
  #settle(): void {
    const settled = this.#settled;
    this.#settled = undefined;
    settled?.resolve();
  }
  #set(next: MediaState): void {
    const before = this.binding()?.connection;
    this.#state = next;
    if (next.state !== "connecting") this.#settle();
    if (this.binding()?.connection === before) return;
    for (const listener of [...this.#watchers]) listener();
  }
}
