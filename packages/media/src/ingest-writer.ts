import { createConnection } from "node:net";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";

/**
 * A producer in the daemon writing to ace-media's ingest socket (an Android device's scrcpy
 * units, forwarded unchanged while its route says ace-media). The hello goes first with the
 * source's single-use token; units follow in order, never coalesced.
 *
 * Every unit counts against `limit` queued bytes, keyframes too. A delta that won't fit is
 * dropped with what follows it to the next keyframe, which is asked for once. A keyframe that
 * won't fit waits, the newest only, until the backlog makes room; each write's completion is
 * checked, not only `drain`, which a socket under its high-water mark never emits. A backlog
 * still too big after `drainLimit` is a cut.
 *
 * The writer is one state machine: `open` → `finishing` (its waiting keyframe, then its end
 * frame) → `ended` | `cut`. `ended` is reached only when the end frame's write succeeds, which is
 * what makes ace-media's end marker a clean one. A finish's deadline stays armed until then.
 * Every failure (a write error, a destroyed socket, a close before `ended`, a deadline) goes
 * through one cut, reported once through `onClosed`. Nothing is written once ended or cut.
 */

/** The part of a socket the writer uses. */
export type IngestSocket = {
  readonly writableLength: number;
  readonly destroyed: boolean;
  write(bytes: Uint8Array, done: (error?: Error | null) => void): boolean;
  end(): unknown;
  destroy(): unknown;
  on(event: "error" | "drain" | "close", listener: () => void): unknown;
};

export type IngestWriterOptions = {
  socket: string;
  /** The source's 32-byte token; zeroed once the hello is written. */
  token: Uint8Array;
  /** The path was cut (not by `close()`): ace-media's marker is an interrupted one. */
  onClosed: (reason?: string) => void;
  onKeyframe: () => void;
  /** Most bytes queued before units are dropped. */
  limit?: number;
  /** Longest the backlog may stay too big, or a finish may take, before the path is cut. */
  drainLimit?: number;
  connect?: (path: string) => IngestSocket;
  /** Runs `run` after `ms`; returns a cancel. */
  after?: (ms: number, run: () => void) => () => void;
};

export const ingestWriterLimit = 4 * 1024 * 1024;
export const ingestDrainLimit = 2_000;

type State =
  | { kind: "open" }
  /** `keyframe`: the waiting keyframe needs room; `end`: the end frame is written, unconfirmed. */
  | { kind: "finishing"; step: "keyframe" | "end" }
  | { kind: "ended" }
  | { kind: "cut" };

function afterTimeout(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export class IngestWriter {
  readonly #socket: IngestSocket;
  readonly #options: IngestWriterOptions;
  #state: State = { kind: "open" };
  /** Deltas are dropped until a keyframe fits. */
  #skipping = false;
  /** The newest keyframe that didn't fit. */
  #pending: Uint8Array | undefined;
  /** The armed deadline: over budget while open, or a finish in progress. */
  #deadline: (() => void) | undefined;

  constructor(options: IngestWriterOptions) {
    this.#options = options;
    const connect = options.connect ?? ((path: string) => createConnection(path));
    this.#socket = connect(options.socket);
    this.#socket.on("error", () => this.#cut("socket-error"));
    this.#socket.on("close", () => this.#cut("closed"));
    this.#socket.on("drain", () => this.#room());
    this.#write(encodeMediaFrame({ ...control(5), payload: options.token.slice() }));
    options.token.fill(0);
  }

  /** The connection is gone, or finishing. */
  get closed(): boolean {
    return this.#state.kind !== "open";
  }

  /** Queues one unit; false once finishing, ended or cut. */
  write(frame: MediaFrame): boolean {
    if (this.#state.kind !== "open") return false;
    if (frame.kind !== 1) {
      this.#write(encodeMediaFrame(frame));
      return true;
    }
    const keyframe = (frame.flags & 1) !== 0;
    // Waiting for room: the newest keyframe replaces the one held, deltas are dropped.
    if (this.#deadline) {
      if (keyframe) this.#pending = encodeMediaFrame(frame);
      else if (!this.#pending) this.#ask();
      return true;
    }
    if (this.#skipping && !keyframe) return true;
    const bytes = encodeMediaFrame(frame);
    if (this.#fits(bytes.length)) {
      this.#skipping = false;
      this.#write(bytes);
      return true;
    }
    if (keyframe) this.#pending = bytes;
    else this.#ask();
    this.#arm();
    return true;
  }

  /**
   * No more units: the waiting keyframe goes once there is room, then the end frame. The path
   * has ended once the end frame's write succeeds; anything else first, or the deadline, is a
   * cut.
   */
  finish(): void {
    if (this.#state.kind !== "open") return;
    this.#disarm();
    this.#arm();
    if (this.#pending) {
      this.#state = { kind: "finishing", step: "keyframe" };
      this.#room();
    } else this.#writeEnd();
  }

  /** At once, dropping what is queued: ace-media sees that path cut. Not reported. */
  close(): void {
    if (this.#state.kind === "ended" || this.#state.kind === "cut") return;
    this.#state = { kind: "cut" };
    this.#stop();
    this.#socket.destroy();
  }

  /** The only way a failure is reported, at most once. */
  #cut(reason: string): void {
    if (this.#state.kind === "ended" || this.#state.kind === "cut") return;
    this.#state = { kind: "cut" };
    this.#stop();
    this.#socket.destroy();
    this.#options.onClosed(reason);
  }

  #stop(): void {
    this.#disarm();
    this.#pending = undefined;
  }

  /** An empty socket takes any unit, so a keyframe bigger than the budget still goes. */
  #fits(bytes: number): boolean {
    const queued = this.#socket.writableLength;
    return queued === 0 || queued + bytes <= (this.#options.limit ?? ingestWriterLimit);
  }

  /** Writes only while open or finishing; each completion is a chance for room. */
  #write(bytes: Uint8Array, done: () => void = () => this.#room()): void {
    const state = this.#state.kind;
    if (state !== "open" && state !== "finishing") return;
    if (this.#socket.destroyed) {
      this.#cut("destroyed");
      return;
    }
    this.#socket.write(bytes, (error) => {
      if (error) this.#cut("write-failed");
      else done();
    });
  }

  #writeEnd(): void {
    this.#state = { kind: "finishing", step: "end" };
    this.#write(encodeMediaFrame({ ...control(4), payload: new Uint8Array(0) }), () => {
      if (this.#state.kind !== "finishing") return;
      this.#state = { kind: "ended" };
      this.#disarm();
      this.#socket.end();
    });
  }

  /** Deltas are dropped to the next keyframe, asked for once. */
  #ask(): void {
    if (this.#skipping) return;
    this.#skipping = true;
    this.#options.onKeyframe();
  }

  #arm(): void {
    const after = this.#options.after ?? afterTimeout;
    this.#deadline = after(this.#options.drainLimit ?? ingestDrainLimit, () => {
      // The backlog as it is now: room made without a `drain` is still room.
      this.#room();
      const state = this.#state.kind;
      if (state === "finishing" || (state === "open" && this.#deadline)) this.#cut("drain-limit");
    });
  }

  #disarm(): void {
    this.#deadline?.();
    this.#deadline = undefined;
  }

  /** Room in the backlog: an open path's waiting keyframe goes, or a finish moves on. */
  #room(): void {
    const state = this.#state;
    if (state.kind === "open" && this.#deadline) {
      const pending = this.#pending;
      if (pending ? !this.#fits(pending.length) : this.#socket.writableLength > this.#limit())
        return;
      this.#disarm();
      this.#pending = undefined;
      if (pending) {
        this.#skipping = false;
        this.#write(pending);
      }
      return;
    }
    if (state.kind === "finishing" && state.step === "keyframe") {
      const pending = this.#pending;
      if (pending && !this.#fits(pending.length)) return;
      this.#pending = undefined;
      if (pending) this.#write(pending);
      // The deadline stays armed until the end frame's write succeeds.
      this.#writeEnd();
    }
  }

  #limit(): number {
    return this.#options.limit ?? ingestWriterLimit;
  }
}

/** A hello (5) or end (4) frame's fields, before its payload. */
function control(kind: 4 | 5): Omit<MediaFrame, "payload"> {
  return {
    kind,
    flags: 0,
    ageUs: 0,
    width: 0,
    height: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1000,
    rotation: 0,
    codec: 0,
    encode: 0,
    epoch: 0,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
  };
}
