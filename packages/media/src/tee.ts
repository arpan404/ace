import { createConnection } from "node:net";
import { ReadStamper, type IssuedEpoch } from "./epochs.ts";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";
import type { FromMedia, MediaFeature, ToMedia } from "./wire.ts";

/**
 * The tee (docs/media/plan.md, "Routes and setting combinations"): frames the daemon already
 * receives, copied into ace-media's ingest for a consumer there, such as the recorder. The
 * daemon is this producer, so it stamps each frame with the epoch it holds when it reads it
 * (`ReadStamper`, with the 100 ms rule after a private epoch) and acknowledges an epoch as soon
 * as it applies it.
 */

/** One encoded unit as the daemon has it. */
export type TeeUnit = {
  kind: "video" | "audio";
  keyframe: boolean;
  /** MediaFrame codec: 1 H.264 Annex B, 2 H.264 AVCC, 3 HEVC Annex B, 4 HEVC HVCC, 9 Opus. */
  codec: number;
  width: number;
  height: number;
  /** avcC/hvcC, or Opus's rate and channels; present on keyframes when the codec needs it. */
  description?: Uint8Array;
  codecString?: string;
  /** Microseconds since capture, when the producer said. */
  ageUs?: number;
  payload: Uint8Array;
};

export interface IngestSocket {
  /** False once the socket holds more than its own buffer; bytes are still queued. */
  write(bytes: Uint8Array): boolean;
  readonly queued: number;
  destroy(): void;
  /** Resolves once connected; rejects if it never connects. */
  readonly ready: Promise<void>;
  /** Called once when the connection ends or fails, unless `destroy` ended it. */
  onClose(listener: () => void): void;
}

export type MediaTeeOptions = {
  source: string;
  /** A handle never used before in this ace-media process. */
  handle: () => number;
  origin: Extract<ToMedia, { type: "source.open" }>["origin"];
  send: (message: ToMedia, payload: Uint8Array) => boolean;
  /** ace-media's ingest socket path now; it changes with every start. */
  ingest: () => string | undefined;
  connect: (path: string) => IngestSocket;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
  /** The tee connected, or dropped deltas while ace-media fell behind: ask the producer for a
   * keyframe. */
  keyframe: () => void;
  /**
   * The established ingest connection was lost while ace-media runs: its socket closed or
   * failed, or ace-media closed the producer (`source.status` `retrying` or `ended`). Units
   * read from now on reach nobody, so the owner must not go on as if they were recorded.
   */
  lost?: (reason: string) => void;
  /** Whether the running ace-media agreed to an optional feature (`ready.features`). */
  speaks?: (feature: MediaFeature) => boolean;
};

/** Past this many queued bytes, deltas are dropped until the next keyframe. */
export const teeQueueLimit = 4 * 1024 * 1024;

export class MediaTee {
  readonly #options: MediaTeeOptions;
  #socket: IngestSocket | undefined;
  /** The token of a `source.open` ace-media hasn't confirmed yet. */
  #token: Uint8Array | undefined;
  #stamper: ReadStamper;
  #epoch: number;
  #skipping = false;
  readonly #accepting: ((ok: boolean) => void)[] = [];
  /** ace-media bound the current connection (`source.ingest`). */
  #bound = false;
  /** Frames written on the current connection since its hello. */
  #frames = 0;
  #nextSync = 0;
  readonly #syncs = new Map<number, (held: boolean) => void>();

  constructor(options: MediaTeeOptions, epoch: number) {
    this.#options = options;
    this.#epoch = epoch;
    this.#stamper = new ReadStamper(epoch);
  }

  /**
   * Opens the source in the running ace-media at the current epoch. Called at start and after
   * every ace-media start (the daemon's replay). False when it isn't running. The tee connects
   * once ace-media reports the source `starting`: a hello that overtook its `source.open` would
   * name a token ace-media doesn't know yet.
   */
  open(): boolean {
    this.#disconnect();
    const { source, origin, randomBytes, send } = this.#options;
    const token = randomBytes(32);
    const message: ToMedia = {
      type: "source.open",
      source,
      handle: this.#options.handle(),
      epoch: this.#epoch,
      origin,
    };
    if (!send(message, token.slice())) {
      token.fill(0);
      return false;
    }
    this.#token = token;
    return true;
  }

  /**
   * ace-media's messages about its own source: `source.status` (connect at `starting`, lost at
   * `retrying` or `ended`), `source.ingest` (ace-media took the hello: accepted) and
   * `source.synced` (a barrier holds).
   */
  message(message: FromMedia): void {
    if (!("source" in message) || message.source !== this.#options.source) return;
    if (message.type === "source.ingest") {
      if (this.#socket && !this.#bound) {
        this.#bound = true;
        this.#settle(true);
      }
      return;
    }
    if (message.type === "source.synced") {
      const waiter = this.#syncs.get(message.seq);
      this.#syncs.delete(message.seq);
      waiter?.(true);
      return;
    }
    if (message.type !== "source.status") return;
    if (message.status === "retrying" || message.status === "ended") {
      if (this.#socket) this.#lose(message.reason ?? `source-${message.status}`);
      return;
    }
    const token = this.#token;
    const path = this.#options.ingest();
    if (message.status !== "starting" || !token || !path) return;
    this.#token = undefined;
    const socket = this.#options.connect(path);
    socket.write(encodeMediaFrame(frame(5, 0, 0, token)));
    token.fill(0);
    this.#socket = socket;
    this.#bound = false;
    this.#frames = 0;
    // Accepted only once ace-media says it bound the hello (`source.ingest`), never on the
    // socket's own connect: it may still refuse the token and close. An ace-media that never
    // agreed to say so is taken at its connect, as before.
    const reports = this.#options.speaks?.("source.ingest") ?? false;
    socket.ready.then(
      () => {
        if (reports || this.#socket !== socket) return;
        this.#bound = true;
        this.#settle(true);
      },
      () => {
        if (this.#socket === socket) this.#lose("ingest-refused");
      },
    );
    socket.onClose(() => {
      if (this.#socket === socket) this.#lose("ingest-closed");
    });
    // ace-media's recorder starts at a keyframe; nothing before one is any use, so ask for one
    // rather than wait out the producer's group.
    this.#skipping = true;
    this.#options.keyframe();
  }

  /** Applies a new epoch to what the tee reads from now on. It is acknowledged at once. */
  epoch(issued: IssuedEpoch): number {
    this.#stamper.apply(issued.epoch, issued.followsPrivate, this.#options.now());
    this.#epoch = issued.epoch;
    return issued.epoch;
  }

  push(unit: TeeUnit): void {
    const socket = this.#socket;
    if (!socket) return;
    if (unit.kind === "video") {
      if (socket.queued > teeQueueLimit && !this.#skipping) {
        this.#skipping = true;
        this.#options.keyframe();
      }
      if (this.#skipping && !unit.keyframe) return;
      this.#skipping = false;
    } else if (this.#skipping) return;
    const epoch = this.#stamper.stamp(this.#options.now());
    const kind = unit.kind === "video" ? 1 : 2;
    const flags = (unit.keyframe ? 1 : 0) | (unit.description ? 4 : 0);
    this.#frames++;
    socket.write(
      encodeMediaFrame({
        ...frame(kind, flags, epoch, unit.payload),
        ageUs: Math.min(Math.max(0, Math.round(unit.ageUs ?? 0)), 0xffffffff),
        width: unit.width,
        height: unit.height,
        displayWidth: unit.width,
        displayHeight: unit.height,
        codec: unit.codec,
        codecString: unit.codecString ?? "",
        description: unit.description ?? new Uint8Array(0),
      }),
    );
  }

  /**
   * Resolves true once ace-media bound the ingest connection of the latest `open`
   * (`source.ingest`), false once that connection failed, was lost, reopened or closed first.
   * Ask after `open`.
   */
  accepted(): Promise<boolean> {
    if (this.#bound) return Promise.resolve(true);
    if (!this.#token && !this.#socket) return Promise.resolve(false);
    return new Promise((resolve) => this.#accepting.push(resolve));
  }

  #settle(ok: boolean): void {
    for (const resolve of this.#accepting.splice(0)) resolve(ok);
  }

  /**
   * An ingest barrier: resolves true once ace-media has taken every frame written so far on
   * the current connection and its recording decided epoch `decided` (`source.sync`), false
   * if the connection goes first or the message can't be sent. The caller bounds the wait.
   */
  sync(decided: number): Promise<boolean> {
    // An ace-media that didn't agree to barriers can't confirm one.
    if (!this.#bound || !(this.#options.speaks?.("source.sync") ?? false))
      return Promise.resolve(false);
    const seq = this.#nextSync++;
    const sent = this.#options.send(
      { type: "source.sync", source: this.#options.source, seq, frames: this.#frames, decided },
      new Uint8Array(0),
    );
    if (!sent) return Promise.resolve(false);
    return new Promise((resolve) => this.#syncs.set(seq, resolve));
  }

  #lose(reason: string): void {
    this.#disconnect();
    this.#options.lost?.(reason);
  }

  #disconnect(): void {
    this.#settle(false);
    for (const waiter of this.#syncs.values()) waiter(false);
    this.#syncs.clear();
    this.#bound = false;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#token?.fill(0);
    this.#token = undefined;
  }

  close(): void {
    this.#disconnect();
    this.#options.send({ type: "source.close", source: this.#options.source }, new Uint8Array(0));
  }
}

function frame(kind: number, flags: number, epoch: number, payload: Uint8Array): MediaFrame {
  return {
    kind,
    flags,
    ageUs: 0,
    width: 0,
    height: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1000,
    rotation: 0,
    codec: 0,
    encode: 0,
    epoch,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload,
  };
}

/** The real ingest connection over `node:net`. */
export function nodeIngestConnect(path: string): IngestSocket {
  const socket = createConnection(path);
  let destroyed = false;
  const listeners: (() => void)[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  ready.catch(() => {});
  // An error is followed by `close`, which reports it.
  socket.on("error", () => {});
  socket.once("close", () => {
    if (!destroyed) for (const listener of listeners.splice(0)) listener();
  });
  return {
    write: (bytes) => socket.write(bytes),
    get queued() {
      return socket.writableLength;
    },
    destroy: () => {
      destroyed = true;
      socket.destroy();
    },
    ready,
    onClose: (listener) => void listeners.push(listener),
  };
}
