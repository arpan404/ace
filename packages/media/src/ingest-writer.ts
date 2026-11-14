import { createConnection, type Socket } from "node:net";
import { encodeMediaFrame, type MediaFrame } from "./frame.ts";

/**
 * A producer in the daemon writing to ace-media's ingest socket (an Android device's scrcpy
 * units, forwarded unchanged while its route says ace-media). The hello goes first with the
 * source's single-use token; units follow in order, never coalesced. Every unit counts against
 * `limit` queued bytes, keyframes too: a delta that won't fit is dropped with what follows it to
 * the next keyframe, which is asked for once; a keyframe that won't fit waits, the newest only,
 * until the backlog written makes room (each write's completion is checked, not only `drain`,
 * which a socket under its high-water mark never emits). A backlog still too big after
 * `drainLimit` has its path closed as a cut, reported through `onClosed`, so the route falls
 * back. A stalled reader never grows the
 * daemon and the stream stays decodable. `finish()` writes what is queued, then ends the
 * connection cleanly, which ace-media follows with the path's end marker. A connection that
 * fails, or that ace-media closes, is reported once.
 */

export type IngestWriterOptions = {
  socket: string;
  /** The source's 32-byte token; zeroed once the hello is written. */
  token: Uint8Array;
  onClosed: () => void;
  onKeyframe: () => void;
  /** Most bytes queued before units are dropped. */
  limit?: number;
  /** Longest the socket may stay over the budget before the path is closed. */
  drainLimit?: number;
  connect?: (path: string) => Socket;
  /** Runs `run` after `ms`; returns a cancel. */
  after?: (ms: number, run: () => void) => () => void;
};

export const ingestWriterLimit = 4 * 1024 * 1024;
export const ingestDrainLimit = 2_000;

function afterTimeout(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

export class IngestWriter {
  readonly #socket: Socket;
  readonly #options: IngestWriterOptions;
  #skipping = false;
  /** The newest keyframe that didn't fit, written once the socket drains. */
  #pending: Uint8Array | undefined;
  /** Cancels the drain limit while the socket is over the budget. */
  #waiting: (() => void) | undefined;
  #ending = false;
  #closed = false;

  constructor(options: IngestWriterOptions) {
    this.#options = options;
    const socket = (options.connect ?? ((path) => createConnection(path)))(options.socket);
    this.#socket = socket;
    socket.on("error", () => {});
    socket.on("drain", () => this.#room());
    socket.once("close", () => {
      // A finish still holding its keyframe never got to its end frame: that is a cut too.
      const reported = !this.#closed && (!this.#ending || this.#pending !== undefined);
      this.#closed = true;
      this.#stopWaiting();
      if (reported) options.onClosed();
    });
    socket.write(encodeMediaFrame({ ...control(5), payload: options.token.slice() }));
    options.token.fill(0);
  }

  /** The connection is gone, or finishing. */
  get closed(): boolean {
    return this.#closed || this.#ending;
  }

  /** Queues one unit; false once closed or finishing. */
  write(frame: MediaFrame): boolean {
    if (this.closed) return false;
    if (frame.kind !== 1) {
      this.#write(encodeMediaFrame(frame));
      return true;
    }
    const keyframe = (frame.flags & 1) !== 0;
    // Waiting for a drain: the newest keyframe replaces the one held, deltas are dropped.
    if (this.#waiting) {
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
    this.#wait();
    return true;
  }

  /** An empty socket takes any unit, so a keyframe bigger than the budget still goes. */
  #fits(bytes: number): boolean {
    const queued = this.#socket.writableLength;
    return queued === 0 || queued + bytes <= this.#limit();
  }

  /** Each write's completion is a chance for a waiting keyframe to go. */
  #write(bytes: Uint8Array): void {
    this.#socket.write(bytes, () => this.#room());
  }

  /** Deltas are dropped to the next keyframe, asked for once. */
  #ask(): void {
    if (this.#skipping) return;
    this.#skipping = true;
    this.#options.onKeyframe();
  }

  /** Over the budget: the backlog must make room within the limit, or the path is cut. */
  #wait(): void {
    const after = this.#options.after ?? afterTimeout;
    this.#waiting = after(this.#options.drainLimit ?? ingestDrainLimit, () => {
      // The backlog as it is now, not as it was: room made without a `drain` is still room.
      this.#room();
      if (!this.#waiting || this.#closed) return;
      this.#waiting = undefined;
      this.close();
      this.#options.onClosed();
    });
  }

  #stopWaiting(): void {
    this.#waiting?.();
    this.#waiting = undefined;
    this.#pending = undefined;
  }

  /** Room in the backlog: the waiting keyframe goes, then a finish's end frame. */
  #room(): void {
    if (!this.#waiting || this.#closed) return;
    const pending = this.#pending;
    if (pending ? !this.#fits(pending.length) : this.#socket.writableLength > this.#limit()) return;
    this.#stopWaiting();
    if (pending) {
      this.#skipping = false;
      this.#write(pending);
    }
    if (this.#ending) this.#end();
  }

  #limit(): number {
    return this.#options.limit ?? ingestWriterLimit;
  }

  #end(): void {
    this.#socket.end(encodeMediaFrame({ ...control(4), payload: new Uint8Array(0) }));
  }

  /**
   * No more units: what is queued is written, then an end frame, then the connection ends. The
   * end frame is what makes ace-media's end marker a clean one; a connection that only closes
   * is a cut path.
   */
  finish(): void {
    if (this.closed) return;
    this.#ending = true;
    // A waiting keyframe was accepted: it goes before the end frame, or the path is a cut.
    if (this.#waiting && this.#pending) return;
    this.#stopWaiting();
    this.#end();
  }

  /** At once, dropping what is queued: ace-media sees that path cut. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopWaiting();
    this.#socket.destroy();
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
